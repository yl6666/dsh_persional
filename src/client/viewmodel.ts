/**
 * Graph editor view model - pure layout and geometry (docs/product-design.md 7.1).
 *
 * Everything the SVG board renders is computed here: repos layer by
 * topological depth (upstream left), contract-cycle members share a layer
 * box, edges draw as horizontal bezier arrows with arrowheads, and hit tests
 * map pointer coordinates back to nodes and edges. No React, no DOM, no
 * network - fully unit-testable.
 * @module dsh-repo-board/client
 */

import type { RepoGraphDocument } from '../graph/types.ts'

/** One node's render position. */
export interface NodeLayout {
  readonly repo: string
  readonly x: number
  readonly y: number
  readonly depth: number
  /** Repo keys sharing this node's SCC unit (cycle batch); empty solo. */
  readonly cyclePeers: readonly string[]
}

/** One edge's render geometry. */
export interface EdgeLayout {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: string
  readonly contract?: string
  readonly status: string
  readonly source: string
  /** Bezier control span for the path `M x1 y1 C x1+dx y1, x2-dx y2, x2 y2`. */
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly dx: number
  /** Midpoint for the interaction hitbox and the label. */
  readonly mx: number
  readonly my: number
}

/** Complete board layout. */
export interface BoardLayout {
  readonly nodes: readonly NodeLayout[]
  readonly edges: readonly EdgeLayout[]
  readonly width: number
  readonly height: number
}

/** Visual metrics of the board canvas. */
export interface BoardMetrics {
  readonly nodeWidth: number
  readonly nodeHeight: number
  readonly layerGap: number
  readonly rowGap: number
  readonly padding: number
}

export const defaultMetrics: BoardMetrics = {
  nodeWidth: 170,
  nodeHeight: 54,
  layerGap: 130,
  rowGap: 22,
  padding: 40,
}

function unitOf(repo: string, units: readonly (readonly string[])[]): readonly string[] {
  for (const unit of units) {
    if (unit.includes(repo)) return unit
  }
  return [repo]
}

/**
 * Layered layout: columns by depth (0 leftmost), rows within a column.
 * Depth comes from BFS over forward edges inside the document (suppressed
 * edges excluded); repos in one SCC share the maximum depth of the unit so a
 * cycle never draws as a back edge.
 */
export function layoutBoard(document: RepoGraphDocument, metrics: BoardMetrics = defaultMetrics): BoardLayout {
  const repos = Object.keys(document.nodes)
  const depth = new Map<string, number>()
  for (const repo of repos) depth.set(repo, 0)
  const edges = document.edges.filter(edge => edge.status !== 'suppressed')
  // Longest-path layering via relaxation: stable after at most n passes; a
  // cycle saturates every member at n-1, which the column merge below evens out.
  for (let pass = 0; pass < repos.length; pass++) {
    let changed = false
    for (const edge of edges) {
      const next = (depth.get(edge.from) ?? 0) + 1
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }

  // Cycle units: connected components over MUTUAL contract edges (A->B and
  // B->A both contract). Members of one unit share the unit's max depth so a
  // cycle never draws as a back edge; the node card lists its peers.
  const contractEdges = document.edges.filter(edge => edge.status !== 'suppressed' && edge.type === 'contract')
  const mutual = new Set<string>()
  for (const edge of contractEdges) {
    if (contractEdges.some(other => other.from === edge.to && other.to === edge.from)) {
      mutual.add(edge.from + '->' + edge.to)
    }
  }
  const adjacency = new Map<string, Set<string>>()
  for (const key of mutual) {
    const [from, to] = key.split('->')
    let set = adjacency.get(from!)
    if (set === undefined) {
      set = new Set<string>()
      adjacency.set(from!, set)
    }
    set.add(to!)
    let other = adjacency.get(to!)
    if (other === undefined) {
      other = new Set<string>()
      adjacency.set(to!, other)
    }
    other.add(from!)
  }
  const cycleUnits: (readonly string[])[] = []
  const assigned = new Set<string>()
  for (const repo of repos) {
    if (assigned.has(repo)) continue
    const unit = [repo]
    assigned.add(repo)
    const queue = [repo]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const neighbor of adjacency.get(current) ?? []) {
        if (assigned.has(neighbor)) continue
        assigned.add(neighbor)
        unit.push(neighbor)
        queue.push(neighbor)
      }
    }
    cycleUnits.push(unit)
  }
  const unitFor = new Map<string, readonly string[]>()
  for (const unit of cycleUnits) {
    for (const repo of unit) unitFor.set(repo, unit)
  }
  const effective = new Map<string, number>()
  for (const unit of cycleUnits) {
    const maxDepth = Math.max(...unit.map(repo => depth.get(repo) ?? 0))
    for (const repo of unit) effective.set(repo, maxDepth)
  }

  const columns = new Map<number, string[]>()
  for (const repo of repos) {
    const column = effective.get(repo) ?? 0
    const list = columns.get(column) ?? []
    list.push(repo)
    columns.set(column, list)
  }
  const maxColumn = Math.max(0, ...columns.keys())
  const nodes: NodeLayout[] = []
  const centerOf = new Map<string, { x: number; y: number }>()
  for (const [column, members] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    const sorted = [...members].sort()
    let cursor = metrics.padding
    for (const repo of sorted) {
      const unit = unitFor.get(repo) ?? [repo]
      const x = metrics.padding + column * (metrics.nodeWidth + metrics.layerGap)
      centerOf.set(repo, { x: x + metrics.nodeWidth / 2, y: cursor + metrics.nodeHeight / 2 })
      nodes.push({
        repo,
        x,
        y: cursor,
        depth: column,
        cyclePeers: unit.filter(peer => peer !== repo),
      })
      cursor += metrics.nodeHeight + metrics.rowGap + (unit.length > 1 ? 14 : 0)
    }
  }
  const width = metrics.padding * 2 + (maxColumn + 1) * metrics.nodeWidth + maxColumn * metrics.layerGap
  const height = Math.max(
    metrics.padding * 2 + metrics.nodeHeight,
    metrics.padding * 2 + Math.max(...nodes.map(node => node.y + metrics.nodeHeight), 0),
  )
  const edgesOut: EdgeLayout[] = document.edges.map(edge => {
    const from = centerOf.get(edge.from)
    const to = centerOf.get(edge.to)
    if (from === undefined || to === undefined) {
      return {
        id: edge.id, from: edge.from, to: edge.to, type: edge.type,
        contract: edge.contractRef?.name, status: edge.status, source: edge.source,
        x1: 0, y1: 0, x2: 0, y2: 0, dx: 0, mx: 0, my: 0,
      }
    }
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2)
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      contract: edge.contractRef?.name,
      status: edge.status,
      source: edge.source,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      dx,
      mx: (from.x + to.x) / 2,
      my: (from.y + to.y) / 2,
    }
  })
  return { nodes, edges: edgesOut, width, height }
}

/** The SVG path of one edge. */
export function edgePath(edge: EdgeLayout): string {
  return 'M ' + edge.x1 + ' ' + edge.y1
    + ' C ' + (edge.x1 + edge.dx) + ' ' + edge.y1 + ', ' + (edge.x2 - edge.dx) + ' ' + edge.y2 + ', ' + edge.x2 + ' ' + edge.y2
}

/** Distance from a point to an edge's midpoint hitbox center. */
export function edgeHitDistance(edge: EdgeLayout, x: number, y: number): number {
  return Math.hypot(edge.mx - x, edge.my - y)
}

/** Find the edge whose midpoint hitbox contains a pointer position. */
export function edgeAt(layout: BoardLayout, x: number, y: number, radius = 18): EdgeLayout | undefined {
  let best: EdgeLayout | undefined
  let bestDistance = radius
  for (const edge of layout.edges) {
    const distance = edgeHitDistance(edge, x, y)
    if (distance <= bestDistance) {
      best = edge
      bestDistance = distance
    }
  }
  return best
}

/** Find the node containing a pointer position (canvas coordinates). */
export function nodeAt(layout: BoardLayout, x: number, y: number, metrics: BoardMetrics = defaultMetrics): NodeLayout | undefined {
  return layout.nodes.find(node => x >= node.x && x <= node.x + metrics.nodeWidth && y >= node.y && y <= node.y + metrics.nodeHeight)
}

/** Edge color per relationship layer (4.1). */
export function edgeColor(type: string, status: string): string {
  if (status === 'suppressed') return '#9ca3af'
  if (type === 'contract') return '#d97706'
  if (type === 'build') return '#2563eb'
  if (type === 'code') return '#7c3aed'
  return '#6b7280'
}

/** Node accent per role in the graph. */
export function nodeAccent(node: NodeLayout): string {
  return node.cyclePeers.length > 0 ? '#dc2626' : '#0f766e'
}
