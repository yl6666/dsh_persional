/**
 * RepoBoard service - the Cordis host half of dsh-repo-board
 * (docs/product-design.md 8). Owns the active RepoGraph store: opening and
 * persisting the graph document, scanning repo directories through the
 * extraction pipeline, and exposing the graph algorithms plus manual edit
 * operations to plugins and tools.
 * @module dsh-repo-board
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  dependencies,
  impact,
  impactReport,
  topologicalUnits,
} from './graph/algorithms.ts'
import type { ImpactReport, TopologicalUnit, TraversalOptions } from './graph/algorithms.ts'
import { RepoGraphStore } from './graph/store.ts'
import type { AutoEdgeInput, ManualEdgeInput, MergeReport } from './graph/store.ts'
import type { RepoGraphDocument, RepoNode } from './graph/types.ts'
import { buildEdgesFromManifests, parseManifests } from './extract/manifest.ts'
import type { ManifestScanResult } from './extract/manifest.ts'
import {
  extractProvidedContracts,
  resolveContractConsumers,
} from './extract/contract.ts'
import type { ContractDeclaration } from './extract/contract.ts'
import { scannedFingerprint, scanRepoDirectory } from './scan/fs.ts'
import { executePlans } from './exec/executor.ts'
import type { RepoGitGateway, RepoTask } from './exec/executor.ts'
import type { ExecutionRun } from './pipeline/types.ts'
import type { DraftRequirement, RequirementDocument } from './pipeline/types.ts'
import { RequirementRecord } from './pipeline/flow.ts'

/** One repo reference for scanning: a stable key plus a local checkout path. */
export interface RepoRef {
  readonly key: string
  readonly path: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    repoBoard: RepoBoardService
  }
}

/**
 * The active multi-repo board: one open RepoGraph per service instance.
 * Graph mutations persist to the file the graph was opened with; queries
 * always read detached immutable documents. The requirement registry (the
 * artifact chain per dispatched requirement, 13.3) persists next to the
 * graph file and reloads on open.
 */
export class RepoBoardService extends Service {
  private store?: RepoGraphStore
  private graphPath?: string
  private readonly requirements = new Map<string, RequirementRecord>()
  private requirementSeq = 0
  /** Repos with a dispatch in flight (6.1 single-pipeline-per-repo mutex). */
  private readonly activeRepos = new Set<string>()
  /** Git gateway from the latest dispatch, used by the submit gate (16.1). */
  private lastGit?: RepoGitGateway

  constructor(ctx: Context) {
    super(ctx, 'repoBoard')
  }

  /** True once a graph has been opened. */
  get isOpen(): boolean {
    return this.store !== undefined
  }

  /** Detached snapshot of the active graph. */
  get document(): RepoGraphDocument {
    return this.requireStore().toDocument()
  }

  /** Persisted requirement records, newest first. */
  listRequirements(): RequirementDocument[] {
    return [...this.requirements.values()].map(record => record.toDocument())
  }

  /** One requirement record by id, or undefined. */
  getRequirement(id: string): RequirementRecord | undefined {
    return this.requirements.get(id)
  }

  /**
   * Register a new dispatched requirement (step input); assigns and persists
   * the next `req-<n>` id.
   */
  async createRequirement(draft: DraftRequirement): Promise<{ id: string; record: RequirementRecord }> {
    this.requireStore()
    this.requirementSeq += 1
    const id = 'req-' + this.requirementSeq
    const record = RequirementRecord.create(id, draft)
    this.requirements.set(id, record)
    await this.persistRequirements()
    return { id, record }
  }

  /** Replace one requirement record (transition results) and persist. */
  async setRequirement(id: string, record: RequirementRecord): Promise<void> {
    const current = this.requirements.get(id)
    if (current === undefined) throw new Error('repo board: unknown requirement ' + id)
    if (record.toDocument().id !== id) throw new Error('repo board: requirement id mismatch')
    this.requirements.set(id, record)
    await this.persistRequirements()
  }

  /** Replace a record via its own id (submit decisions); persists. */
  private async replaceRequirement(record: RequirementRecord): Promise<void> {
    await this.setRequirement(record.toDocument().id, record)
  }

  /**
   * Open (or create) the graph document at `graphPath`. A missing file
   * creates an empty graph for `project`; an existing file must validate.
   * Requirement records persist alongside and reload here.
   */
  async open(project: string, graphPath: string): Promise<RepoGraphDocument> {
    let raw: string
    try {
      raw = await readFile(graphPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.store = RepoGraphStore.create(project)
        this.graphPath = graphPath
        await this.persist()
        return this.document
      }
      throw error
    }
    const parsed = JSON.parse(raw) as unknown
    this.store = RepoGraphStore.load(parsed as RepoGraphDocument)
    this.graphPath = graphPath
    await this.loadRequirements()
    return this.document
  }

  /**
   * Scan repo directories and merge manifest + contract edges into the active
   * graph (design 4.3 tier one and two). Nodes are upserted with display
   * names from their manifests, build-system metadata, and rescan
   * fingerprints. Merging is idempotent; manual edges and suppressions are
   * preserved by the store's merge strategy.
   */
  async scan(repos: readonly RepoRef[]): Promise<RepoGraphDocument> {
    const store = this.requireStore()
    const manifestScans: ManifestScanResult[] = []
    const contractsByRepo = new Map<string, readonly ContractDeclaration[]>()
    const filesByRepo: Record<string, Record<string, string>> = {}
    for (const repo of repos) {
      const files = await scanRepoDirectory(repo.path)
      const scan = parseManifests(repo.key, files.manifest)
      manifestScans.push(scan)
      const node: RepoNode = {
        name: scan.provides[0]?.name ?? repo.key,
        path: repo.path,
        labels: [],
        fingerprint: scannedFingerprint(files),
        meta: { build: scan.buildSystems },
      }
      store.upsertNode(repo.key, node)
      const provided = extractProvidedContracts(repo.key, files.contracts)
      if (provided.length > 0) contractsByRepo.set(repo.key, provided)
      filesByRepo[repo.key] = { ...files.contracts, ...files.sources }
    }
    const buildEdges = buildEdgesFromManifests(manifestScans)
    const contractEdges = resolveContractConsumers({ contracts: contractsByRepo, files: filesByRepo })
    store.mergeAutoEdges([...buildEdges, ...contractEdges])
    await this.persist()
    return this.document
  }

  /** Upsert one repo node by hand (graph editor backend). Persists. */
  async upsertNode(key: string, node: RepoNode): Promise<RepoGraphDocument> {
    this.requireStore().upsertNode(key, node)
    await this.persist()
    return this.document
  }

  /** Draw one edge by hand; manual edges beat auto merges forever (7.1). Persists. */
  async addManualEdge(input: ManualEdgeInput): Promise<RepoGraphDocument> {
    this.requireStore().addManualEdge(input)
    await this.persist()
    return this.document
  }

  /** Suppress one relation; auto analysis stops suggesting it (7.1). Persists. */
  async suppressEdge(id: string, reason?: string): Promise<RepoGraphDocument> {
    this.requireStore().suppressEdge(id, reason)
    await this.persist()
    return this.document
  }

  /** Confirm one candidate edge. Persists. */
  async confirmEdge(id: string): Promise<RepoGraphDocument> {
    this.requireStore().confirmEdge(id)
    await this.persist()
    return this.document
  }

  /** Drop one edge entirely. Persists. */
  async removeEdge(id: string): Promise<RepoGraphDocument> {
    this.requireStore().removeEdge(id)
    await this.persist()
    return this.document
  }

  /** Drop one repo node and its incident edges. Persists. */
  async removeNode(key: string): Promise<RepoGraphDocument> {
    this.requireStore().removeNode(key)
    await this.persist()
    return this.document
  }

  /** Merge raw auto edges (pipeline/testing hook). */
  mergeAutoEdges(inputs: readonly AutoEdgeInput[]): MergeReport {
    return this.requireStore().mergeAutoEdges(inputs)
  }

  /** Forward reachable set: everything `repo` depends on. */
  dependencies(repo: string, options?: TraversalOptions): string[] {
    return dependencies(this.document, repo, options)
  }

  /** Reverse reachable set: the blast radius of `repo`. */
  impact(repo: string, options?: TraversalOptions): string[] {
    return impact(this.document, repo, options)
  }

  /** Full blast-radius report for `repo`. */
  impactReport(repo: string, options?: TraversalOptions): ImpactReport {
    return impactReport(this.document, repo, options)
  }

  /** Topological scheduling units, upstream first, cycles condensed (13.2). */
  topologicalUnits(repos?: readonly string[], options?: TraversalOptions): TopologicalUnit[] {
    return topologicalUnits(this.document, repos, options)
  }

  /**
   * Steps [5]-[6]: execute a planned requirement's repo tasks upstream first
   * (design 6). Repo checkout paths come from the graph nodes; the injected
   * task runs once per plan (one DSH session per repo in production).
   * Manual commit policy stops each repo at a submit request (16.1); the
   * same requirement's repos may not overlap another running dispatch (6.1).
   *
   * A dispatched requirement re-enters here for a re-dispatch (17.3): repos
   * that already succeeded stay put (their commits exist), everything else
   * re-runs with its prior failure history seeded into the retry prompt.
   * Repos still awaiting a submit decision block the whole re-dispatch -
   * decide those first.
   */
  async dispatchRequirement(
    record: RequirementRecord,
    task: RepoTask,
    options: {
      concurrency?: number
      git?: RepoGitGateway
      commitPolicy?: 'auto' | 'manual'
      maxAttempts?: number
    } = {},
  ): Promise<{ record: RequirementRecord; run: ExecutionRun }> {
    let working = record
    let previousRun: ExecutionRun | undefined
    if (record.status === 'dispatched') {
      const run = record.toDocument().run
      if (run === undefined) throw new Error('repo board: dispatched requirement carries no run - cannot re-dispatch')
      const pending = run.perRepo.filter(entry => entry.state === 'submit-pending').map(entry => entry.repo)
      if (pending.length > 0) {
        throw new Error(
          'repo board: repos still awaiting submit decisions (' + pending.sort().join(', ') +
          ') - approve or reject them before re-dispatching',
        )
      }
      const settled = run.perRepo
        .filter(entry => entry.state === 'succeeded' || entry.state === 'submitted')
        .map(entry => entry.repo)
      const plans = record.toDocument().plans
      if (plans === undefined) throw new Error('repo board: dispatched requirement carries no plans')
      if (plans.every(plan => settled.includes(plan.repo))) {
        throw new Error('repo board: nothing to re-dispatch - every repo already settled')
      }
      working = record.reDispatch()
      previousRun = run
    } else if (record.status !== 'planned') {
      throw new Error('repo board: only planned requirements can be dispatched')
    }
    const plans = working.toDocument().plans
    if (plans === undefined) throw new Error('repo board: planned requirement carries no plans')
    const settledSet = previousRun === undefined
      ? new Set<string>()
      : new Set(previousRun.perRepo
          .filter(entry => entry.state === 'succeeded' || entry.state === 'submitted')
          .map(entry => entry.repo))
    const plansToRun = plans.filter(plan => !settledSet.has(plan.repo))
    const repoPaths: Record<string, string> = {}
    for (const key of Object.keys(this.document.nodes)) {
      const path = this.document.nodes[key]?.path
      if (path !== undefined) repoPaths[key] = path
    }
    // Per-repo mutex (6.1): one pipeline per repo at a time.
    const repos = plansToRun.map(plan => plan.repo)
    const conflicts = repos.filter(repo => this.activeRepos.has(repo))
    if (conflicts.length > 0) {
      throw new Error('repo board: these repos already have a running dispatch: ' + conflicts.sort().join(', '))
    }
    for (const repo of repos) this.activeRepos.add(repo)
    // Re-dispatch failure history (17.3): each retried repo's prior errors.
    const history: Record<string, readonly string[]> = {}
    if (previousRun !== undefined) {
      for (const plan of plansToRun) {
        const prefix = plan.repo + ':'
        const prior = previousRun.errors.filter(error => error.startsWith(prefix))
        if (prior.length > 0) history[plan.repo] = prior
      }
    }
    let run: ExecutionRun
    try {
      run = await executePlans(plansToRun, task, {
        repoPaths,
        concurrency: options.concurrency,
        git: options.git,
        commitPolicy: options.commitPolicy,
        maxAttempts: options.maxAttempts,
        branchBase: 'ai-delivery/' + working.toDocument().id,
        history,
      })
    } catch (error) {
      for (const repo of repos) this.activeRepos.delete(repo)
      throw error
    }
    // Submit-pending repos stay under the mutex until their human decision:
    // their uncommitted worktree changes must not be caught by another run.
    const holding = new Set(run.perRepo.filter(entry => entry.state === 'submit-pending').map(entry => entry.repo))
    for (const repo of repos) {
      if (!holding.has(repo)) this.activeRepos.delete(repo)
    }
    this.lastGit = options.git
    let finalRun = run
    if (previousRun !== undefined) {
      const retained = previousRun.perRepo.filter(entry => settledSet.has(entry.repo))
      const retainedRepos = new Set(retained.map(entry => entry.repo))
      const retainedErrors = previousRun.errors.filter(error =>
        [...retainedRepos].some(repo => error.startsWith(repo + ':')),
      )
      finalRun = {
        perRepo: [...retained, ...run.perRepo.filter(entry => !retainedRepos.has(entry.repo))],
        errors: [...retainedErrors, ...run.errors],
      }
    }
    return { record: working.dispatch(finalRun), run: finalRun }
  }

  /**
   * Human submit gate (16.1): approve one repo's pending submit request by
   * committing its changes host-side on the requirement branch. Requires the
   * git gateway from the dispatch that created the pending state.
   */
  async approveSubmit(
    record: RequirementRecord,
    repo: string,
    options: { message?: string } = {},
  ): Promise<RequirementRecord> {
    const run = record.toDocument().run
    if (record.status !== 'dispatched' || run === undefined) {
      throw new Error('repo board: only a dispatched requirement can be submitted')
    }
    const entry = run.perRepo.find(item => item.repo === repo)
    if (entry === undefined) throw new Error('repo board: no run entry for repo ' + repo)
    if (entry.state !== 'submit-pending' || entry.submitRequest === undefined) {
      throw new Error('repo board: repo ' + repo + ' is not waiting for a submit decision (state: ' + entry.state + ')')
    }
    if (this.lastGit === undefined) {
      throw new Error('repo board: no git gateway from the dispatch - cannot commit')
    }
    const repoPath = this.document.nodes[repo]?.path
    if (repoPath === undefined) throw new Error('repo board: repo ' + repo + ' has no checkout path in the graph')
    // The worktree must still sit on the submit request's branch: anything
    // else means someone moved it after the session finished, and the
    // pending changes may no longer be what the human approved.
    const branch = await this.lastGit.currentBranch(repoPath)
    if (branch !== entry.submitRequest.branch) {
      throw new Error(
        'repo board: ' + repo + ' is on branch ' + branch + ' but its submit request expects ' +
        entry.submitRequest.branch + ' - refusing to commit',
      )
    }
    const commit = await this.lastGit.commitAll(
      repoPath,
      options.message ?? 'ai(' + repo + '): ' + entry.submitRequest.summary,
    )
    const nextRun: ExecutionRun = {
      perRepo: run.perRepo.map(item =>
        item.repo === repo ? { ...item, state: 'submitted' as const, commit } : item,
      ),
      errors: run.errors.filter(error => !error.startsWith(repo + ':')),
    }
    const next = record.updateRun(nextRun)
    await this.replaceRequirement(next)
    // The submit decision settles the repo: release the per-repo mutex (6.1).
    this.activeRepos.delete(repo)
    return next
  }

  /**
   * Reject one repo's pending submit request (16.1): the repo lands in
   * needs-human with the rejection recorded, and no commit is made.
   */
  async rejectSubmit(record: RequirementRecord, repo: string, reason?: string): Promise<RequirementRecord> {
    const run = record.toDocument().run
    if (record.status !== 'dispatched' || run === undefined) {
      throw new Error('repo board: only a dispatched requirement can be rejected')
    }
    const entry = run.perRepo.find(item => item.repo === repo)
    if (entry === undefined) throw new Error('repo board: no run entry for repo ' + repo)
    if (entry.state !== 'submit-pending') {
      throw new Error('repo board: repo ' + repo + ' is not waiting for a submit decision (state: ' + entry.state + ')')
    }
    const rejection = 'submit rejected for ' + repo + (reason === undefined || reason === '' ? '' : ': ' + reason)
    const nextRun: ExecutionRun = {
      perRepo: run.perRepo.map(item =>
        item.repo === repo ? { ...item, state: 'needs-human' as const } : item,
      ),
      errors: [...run.errors.filter(error => !error.startsWith(repo + ':')), rejection],
    }
    const next = record.updateRun(nextRun)
    await this.replaceRequirement(next)
    // The rejection settles the pending state: release the per-repo mutex.
    this.activeRepos.delete(repo)
    return next
  }

  private requireStore(): RepoGraphStore {
    if (this.store === undefined) {
      throw new Error('repo board: no graph is open - call open(project, graphPath) first')
    }
    return this.store
  }

  private requirementsPath(): string {
    const graphPath = this.graphPath ?? 'graph.json'
    const dir = dirname(graphPath)
    const base = graphPath.split(/[\\/]/).pop() ?? 'graph.json'
    return dir + '/' + base.replace(/\.json$/, '') + '.requirements.json'
  }

  private async persistRequirements(): Promise<void> {
    if (this.graphPath === undefined) return
    const path = this.requirementsPath()
    await mkdir(dirname(path), { recursive: true })
    const documents = this.listRequirements()
    await writeFile(
      path,
      JSON.stringify({ version: 1, seq: this.requirementSeq, requirements: documents }, null, 2),
      'utf8',
    )
  }

  private async loadRequirements(): Promise<void> {
    const path = this.requirementsPath()
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as { version?: unknown; seq?: unknown; requirements?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.requirements)) {
      throw new Error('repo board: malformed requirements file ' + path)
    }
    this.requirements.clear()
    for (const document of parsed.requirements) {
      const record = RequirementRecord.load(document as RequirementDocument)
      this.requirements.set(record.toDocument().id, record)
    }
    this.requirementSeq = typeof parsed.seq === 'number' ? parsed.seq : this.requirements.size
  }

  private async persist(): Promise<void> {
    if (this.graphPath === undefined) return
    await mkdir(dirname(this.graphPath), { recursive: true })
    await writeFile(this.graphPath, JSON.stringify(this.document, null, 2), 'utf8')
  }
}

export default RepoBoardService
