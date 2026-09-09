/**
 * RepoGraph algorithms (docs/product-design.md 13.2).
 *
 * Direction convention (inherited from types.ts): edge `A -> B` means A
 * depends on B. Consequences: dependencies() follows forward edges (what A
 * needs), impact() follows reverse edges (who needs A), and the topological
 * order places upstream providers before downstream consumers.
 * @module dsh-repo-board
 */

import type { RepoEdge, RepoEdgeType, RepoGraphDocument } from './types.ts'

/** Options constraining which edges a traversal follows. */
export interface TraversalOptions {
  /** Restrict traversal to these edge types; default: all types. */
  readonly edgeTypes?: readonly RepoEdgeType[]
  /** Only traverse `confirmed` edges; default also follows candidates. */
  readonly confirmedOnly?: boolean
}

/** Blast-radius report for one repo (13.2 - impact). */
export interface ImpactReport {
  /** The repo the analysis started from. */
  readonly repo: string
  /** Repos that depend on `repo` through a direct edge. Sorted. */
  readonly direct: readonly string[]
  /** Repos that depend on `repo` only transitively. Sorted. */
  readonly transitive: readonly string[]
  /** Per-edge-type breakdown: repos reachable using only that edge type. */
  readonly byEdgeType: Readonly<Record<RepoEdgeType, readonly string[]>>
}

/** One scheduling unit after SCC condensation: a repo or an atomic cycle batch. */
export interface TopologicalUnit {
  /** Member repo keys; more than one member (or a self-loop) means an atomic cycle batch. */
  readonly repos: readonly string[]
  /** 0 for units with no upstream inside the subgraph; else 1 + max upstream depth. */
  readonly depth: number
  /** True when contract edges participate in the cycle - forces human review (13.2-3). */
  readonly hasContractCycle: boolean
}

/** One task's declared write scopes (advisory path prefixes, 13.2-4). */
export interface RepoTaskScopes {
  readonly repo: string
  readonly writeScopes: readonly string[]
}

/** A pairwise write-scope overlap between two parallel tasks. */
export interface WriteScopeConflict {
  readonly repoA: string
  readonly repoB: string
  /** Overlapping scope pairs, formatted `a <-> b`. */
  readonly overlaps: readonly string[]
}

const allEdgeTypes: readonly RepoEdgeType[] = ['build', 'code', 'contract', 'semantic']

function traversable(edge: RepoEdge, options: TraversalOptions | undefined): boolean {
  if (edge.status === 'suppressed') return false
  if (options?.confirmedOnly === true && edge.status !== 'confirmed') return false
  const types = options?.edgeTypes
  if (types !== undefined && !types.includes(edge.type)) return false
  return true
}

function requireKnownRepo(graph: RepoGraphDocument, repo: string): void {
  if (graph.nodes[repo] === undefined) throw new TypeError('unknown repo: ' + repo)
}

/**
 * Breadth-first distances from `start` over traversable edges.
 * `direction === 'forward'` walks dependencies; `'backward'` walks dependents.
 * The start repo itself is excluded from the result.
 */
function reachabilityDistances(
  graph: RepoGraphDocument,
  start: string,
  direction: 'forward' | 'backward',
  options?: TraversalOptions,
): Map<string, number> {
  const adjacency = new Map<string, string[]>()
  const record = (key: string, other: string): void => {
    const list = adjacency.get(key)
    if (list === undefined) adjacency.set(key, [other])
    else list.push(other)
  }
  for (const edge of graph.edges) {
    if (!traversable(edge, options)) continue
    if (graph.nodes[edge.from] === undefined || graph.nodes[edge.to] === undefined) continue
    if (direction === 'forward') record(edge.from, edge.to)
    else record(edge.to, edge.from)
  }
  const distances = new Map<string, number>([[start, 0]])
  const queue: string[] = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    const distance = distances.get(current)!
    for (const next of adjacency.get(current) ?? []) {
      if (!distances.has(next)) {
        distances.set(next, distance + 1)
        queue.push(next)
      }
    }
  }
  distances.delete(start)
  return distances
}

function reachableKeys(
  graph: RepoGraphDocument,
  start: string,
  direction: 'forward' | 'backward',
  options?: TraversalOptions,
): string[] {
  return [...reachabilityDistances(graph, start, direction, options).keys()].sort()
}

/** The forward reachable set: everything `repo` depends on (13.2-1). Sorted. */
export function dependencies(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): string[] {
  requireKnownRepo(graph, repo)
  return reachableKeys(graph, repo, 'forward', options)
}

/** The reverse reachable set: everything that depends on `repo` - the blast radius. Sorted. */
export function impact(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): string[] {
  requireKnownRepo(graph, repo)
  return reachableKeys(graph, repo, 'backward', options)
}

/** Full blast-radius report: direct vs transitive dependents plus per-type breakdown. */
export function impactReport(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): ImpactReport {
  requireKnownRepo(graph, repo)
  const distances = reachabilityDistances(graph, repo, 'backward', options)
  const direct: string[] = []
  const transitive: string[] = []
  for (const [key, distance] of distances) {
    ;(distance === 1 ? direct : transitive).push(key)
  }
  direct.sort()
  transitive.sort()
  const byEdgeType = {} as Record<RepoEdgeType, readonly string[]>
  for (const type of allEdgeTypes) {
    byEdgeType[type] = reachableKeys(graph, repo, 'backward', { ...options, edgeTypes: [type] })
  }
  return { repo, direct, transitive, byEdgeType }
}

/** Tarjan strongly-connected components over the induced subgraph. */
function stronglyConnectedComponents(nodes: readonly string[], edges: readonly RepoEdge[]): string[][] {
  const adjacency = new Map<string, string[]>(nodes.map((node): [string, string[]] => [node, []]))
  for (const edge of edges) adjacency.get(edge.from)!.push(edge.to)
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  const strongconnect = (v: string): void => {
    indices.set(v, index)
    lowlink.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        component.push(w)
        if (w === v) break
      }
      component.sort()
      components.push(component)
    }
  }
  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v)
  }
  return components
}

/**
 * Topological scheduling units over the induced subgraph of `repos`
 * (default: every node). Upstream first: a unit's depth is one more than the
 * deepest unit it depends on. Cycles condense into atomic batch units
 * (13.2-3); units participate in a contract cycle are flagged for review.
 */
export function topologicalUnits(
  graph: RepoGraphDocument,
  repos?: readonly string[],
  options?: TraversalOptions,
): TopologicalUnit[] {
  const nodeKeys = repos === undefined ? Object.keys(graph.nodes) : [...new Set(repos)]
  for (const key of nodeKeys) requireKnownRepo(graph, key)
  const inSet = new Set(nodeKeys)
  const induced = graph.edges.filter(
    edge => traversable(edge, options) && inSet.has(edge.from) && inSet.has(edge.to),
  )
  const components = stronglyConnectedComponents(nodeKeys, induced)
  const unitOf = new Map<string, number>()
  components.forEach((component, i) => {
    for (const repo of component) unitOf.set(repo, i)
  })
  const hasSelfLoop = (i: number): boolean =>
    induced.some(edge => edge.from === edge.to && components[i]!.includes(edge.from))
  const hasContractInside = (i: number): boolean =>
    induced.some(
      edge => edge.type === 'contract' && components[i]!.includes(edge.from) && components[i]!.includes(edge.to),
    )
  // Condensation: upstream[i] lists units that unit i depends on.
  const upstream = new Map<number, Set<number>>()
  for (const edge of induced) {
    const from = unitOf.get(edge.from)!
    const to = unitOf.get(edge.to)!
    if (from === to) continue
    let set = upstream.get(from)
    if (set === undefined) {
      set = new Set<number>()
      upstream.set(from, set)
    }
    set.add(to)
  }
  const depthCache = new Map<number, number>()
  const computeDepth = (i: number, visiting: Set<number>): number => {
    const cached = depthCache.get(i)
    if (cached !== undefined) return cached
    if (visiting.has(i)) return 0
    visiting.add(i)
    let depth = 0
    for (const up of upstream.get(i) ?? []) depth = Math.max(depth, 1 + computeDepth(up, visiting))
    visiting.delete(i)
    depthCache.set(i, depth)
    return depth
  }
  const units: TopologicalUnit[] = components.map((component, i) => ({
    repos: component,
    depth: computeDepth(i, new Set<number>()),
    hasContractCycle: component.length > 1 || hasSelfLoop(i) ? hasContractInside(i) : false,
  }))
  return units.sort((a, b) => a.depth - b.depth || a.repos.join('+').localeCompare(b.repos.join('+')))
}

/** Normalize one write scope: backslashes to slashes, collapsed separators, no trailing slash. */
export function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function scopesOverlap(a: string, b: string): boolean {
  if (a === b) return true
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

/**
 * Pairwise write-scope conflicts across parallel tasks (13.2-4). Two scopes
 * overlap when equal or when one is a path-prefix of the other; plain string
 * prefixes without a separator boundary never conflict (`srcx` vs `src`).
 */
export function writeScopeConflicts(tasks: readonly RepoTaskScopes[]): WriteScopeConflict[] {
  const conflicts: WriteScopeConflict[] = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!
      const b = tasks[j]!
      const overlaps = new Set<string>()
      for (const rawSa of a.writeScopes) {
        for (const rawSb of b.writeScopes) {
          const sa = normalizeScope(rawSa)
          const sb = normalizeScope(rawSb)
          if (sa !== '' && sb !== '' && scopesOverlap(sa, sb)) overlaps.add(sa + ' <-> ' + sb)
        }
      }
      if (overlaps.size > 0) {
        conflicts.push({ repoA: a.repo, repoB: b.repo, overlaps: [...overlaps] })
      }
    }
  }
  return conflicts
}
