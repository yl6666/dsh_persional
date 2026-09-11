/**
 * RepoBoard service - the Cordis host half of dsh-repo-board
 * (docs/product-design.md 8). Owns the active RepoGraph store: opening and
 * persisting the graph document, scanning repo directories through the
 * extraction pipeline, and exposing the graph algorithms plus manual edit
 * operations to plugins and tools.
 * @module dsh-repo-board
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { ImpactReport, TopologicalUnit, TraversalOptions } from './graph/algorithms.ts';
import type { AutoEdgeInput, ManualEdgeInput, MergeReport } from './graph/store.ts';
import type { RepoGraphDocument, RepoNode } from './graph/types.ts';
import type { RepoGitGateway, RepoTask } from './exec/executor.ts';
import type { ExecutionRun } from './pipeline/types.ts';
import type { DraftRequirement, RequirementDocument } from './pipeline/types.ts';
import { RequirementRecord } from './pipeline/flow.ts';
/** One repo reference for scanning: a stable key plus a local checkout path. */
export interface RepoRef {
    readonly key: string;
    readonly path: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        repoBoard: RepoBoardService;
    }
}
/**
 * The active multi-repo board: one open RepoGraph per service instance.
 * Graph mutations persist to the file the graph was opened with; queries
 * always read detached immutable documents. The requirement registry (the
 * artifact chain per dispatched requirement, 13.3) persists next to the
 * graph file and reloads on open.
 */
export declare class RepoBoardService extends Service {
    private store?;
    private graphPath?;
    private readonly requirements;
    private requirementSeq;
    /** Repos with a dispatch in flight (6.1 single-pipeline-per-repo mutex). */
    private readonly activeRepos;
    /** Git gateway from the latest dispatch, used by the submit gate (16.1). */
    private lastGit?;
    constructor(ctx: Context);
    /** True once a graph has been opened. */
    get isOpen(): boolean;
    /** Detached snapshot of the active graph. */
    get document(): RepoGraphDocument;
    /** Persisted requirement records, newest first. */
    listRequirements(): RequirementDocument[];
    /** One requirement record by id, or undefined. */
    getRequirement(id: string): RequirementRecord | undefined;
    /**
     * Register a new dispatched requirement (step input); assigns and persists
     * the next `req-<n>` id.
     */
    createRequirement(draft: DraftRequirement): Promise<{
        id: string;
        record: RequirementRecord;
    }>;
    /** Replace one requirement record (transition results) and persist. */
    setRequirement(id: string, record: RequirementRecord): Promise<void>;
    /** Replace a record via its own id (submit decisions); persists. */
    private replaceRequirement;
    /**
     * Open (or create) the graph document at `graphPath`. A missing file
     * creates an empty graph for `project`; an existing file must validate.
     * Requirement records persist alongside and reload here.
     */
    open(project: string, graphPath: string): Promise<RepoGraphDocument>;
    /**
     * Scan repo directories and merge manifest + contract edges into the active
     * graph (design 4.3 tier one and two). Nodes are upserted with display
     * names from their manifests, build-system metadata, and rescan
     * fingerprints. Merging is idempotent; manual edges and suppressions are
     * preserved by the store's merge strategy.
     */
    scan(repos: readonly RepoRef[]): Promise<RepoGraphDocument>;
    /** Upsert one repo node by hand (graph editor backend). Persists. */
    upsertNode(key: string, node: RepoNode): Promise<RepoGraphDocument>;
    /** Draw one edge by hand; manual edges beat auto merges forever (7.1). Persists. */
    addManualEdge(input: ManualEdgeInput): Promise<RepoGraphDocument>;
    /** Suppress one relation; auto analysis stops suggesting it (7.1). Persists. */
    suppressEdge(id: string, reason?: string): Promise<RepoGraphDocument>;
    /** Confirm one candidate edge. Persists. */
    confirmEdge(id: string): Promise<RepoGraphDocument>;
    /** Drop one edge entirely. Persists. */
    removeEdge(id: string): Promise<RepoGraphDocument>;
    /** Drop one repo node and its incident edges. Persists. */
    removeNode(key: string): Promise<RepoGraphDocument>;
    /** Merge raw auto edges (pipeline/testing hook). */
    mergeAutoEdges(inputs: readonly AutoEdgeInput[]): MergeReport;
    /** Forward reachable set: everything `repo` depends on. */
    dependencies(repo: string, options?: TraversalOptions): string[];
    /** Reverse reachable set: the blast radius of `repo`. */
    impact(repo: string, options?: TraversalOptions): string[];
    /** Full blast-radius report for `repo`. */
    impactReport(repo: string, options?: TraversalOptions): ImpactReport;
    /** Topological scheduling units, upstream first, cycles condensed (13.2). */
    topologicalUnits(repos?: readonly string[], options?: TraversalOptions): TopologicalUnit[];
    /**
     * Steps [5]-[6]: execute a planned requirement's repo tasks upstream first
     * (design 6). Repo checkout paths come from the graph nodes; the injected
     * task runs once per plan (one DSH session per repo in production).
     * Manual commit policy stops each repo at a submit request (16.1); the
     * same requirement's repos may not overlap another running dispatch (6.1).
     */
    dispatchRequirement(record: RequirementRecord, task: RepoTask, options?: {
        concurrency?: number;
        git?: RepoGitGateway;
        commitPolicy?: 'auto' | 'manual';
        maxAttempts?: number;
    }): Promise<{
        record: RequirementRecord;
        run: ExecutionRun;
    }>;
    /**
     * Human submit gate (16.1): approve one repo's pending submit request by
     * committing its changes host-side on the requirement branch. Requires the
     * git gateway from the dispatch that created the pending state.
     */
    approveSubmit(record: RequirementRecord, repo: string, options?: {
        message?: string;
    }): Promise<RequirementRecord>;
    /**
     * Reject one repo's pending submit request (16.1): the repo lands in
     * needs-human with the rejection recorded, and no commit is made.
     */
    rejectSubmit(record: RequirementRecord, repo: string, reason?: string): Promise<RequirementRecord>;
    private requireStore;
    private requirementsPath;
    private persistRequirements;
    private loadRequirements;
    private persist;
}
export default RepoBoardService;
