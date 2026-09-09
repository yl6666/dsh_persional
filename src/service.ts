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
 * always read detached immutable documents.
 */
export class RepoBoardService extends Service {
  private store?: RepoGraphStore
  private graphPath?: string

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

  /**
   * Open (or create) the graph document at `graphPath`. A missing file
   * creates an empty graph for `project`; an existing file must validate.
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

  private requireStore(): RepoGraphStore {
    if (this.store === undefined) {
      throw new Error('repo board: no graph is open - call open(project, graphPath) first')
    }
    return this.store
  }

  private async persist(): Promise<void> {
    if (this.graphPath === undefined) return
    await mkdir(dirname(this.graphPath), { recursive: true })
    await writeFile(this.graphPath, JSON.stringify(this.document, null, 2), 'utf8')
  }
}

export default RepoBoardService
