/**
 * Requirement pipeline flow - the pure transitions between dispatch-step
 * artifacts (docs/product-design.md 13.3): clarification gating, graph-backed
 * impact analysis, plan scaffolding, and review findings.
 *
 * The LLM seam lives above this module: a planner fills the skeletons these
 * functions produce. Everything here is deterministic over the RepoGraph.
 * @module dsh-repo-board
 */
import type { WriteScopeConflict } from '../graph/algorithms.ts';
import type { RepoGraphDocument } from '../graph/types.ts';
import type { ClarificationQuestion, ClarificationSession, CriticalEdge, DraftRequirement, ExecutionRun, ImpactAnalysis, RepoModificationPlan, RequirementDocument, RequirementSpec } from './types.ts';
/**
 * Effective answers of one session: explicit answers, plus defaults for
 * unanswered non-blocking questions (5.2: 可默认级给默认).
 */
export declare function effectiveAnswers(session: ClarificationSession): Record<string, string>;
/** True when every blocking question has an explicit answer. */
export declare function blockingAnswersComplete(session: ClarificationSession): boolean;
/**
 * Step [2]: analyze the spec's blast radius over the graph. candidateRepos
 * not present in the graph are reported as unknownRepos (5.2 anomaly) and
 * excluded from topology instead of crashing.
 */
export declare function analyzeImpact(graph: RepoGraphDocument, spec: RequirementSpec): ImpactAnalysis;
/** Downstream consumers of one repo's contracts, precise to the contract (5.3). */
export declare function planDownstream(graph: RepoGraphDocument, repo: string): {
    repo: string;
    via: string;
}[];
/**
 * Step [3] scaffold: deterministic per-repo plan skeletons in execution
 * order. Prerequisites come from the graph (upstream first); the planner
 * LLM fills summary/changes/writeScopes/breaking before attach.
 */
export declare function scaffoldPlans(graph: RepoGraphDocument, analysis: ImpactAnalysis, spec: RequirementSpec): RepoModificationPlan[];
/** Write-scope conflicts across a plan set (13.2-4). */
export declare function planConflicts(plans: readonly RepoModificationPlan[]): WriteScopeConflict[];
/** Step [4] findings a human must review: declared breakings plus scope conflicts. */
export interface ReviewFindings {
    readonly conflicts: readonly WriteScopeConflict[];
    readonly breakingChanges: readonly {
        repo: string;
        breaking: readonly string[];
    }[];
    readonly criticalEdges: readonly CriticalEdge[];
}
/** Collect the review payload for a plan set against its analysis. */
export declare function reviewFindings(graph: RepoGraphDocument, analysis: ImpactAnalysis, plans: readonly RepoModificationPlan[]): ReviewFindings;
/**
 * The artifact chain for one dispatched requirement. Transitions validate
 * their preconditions and return a new record; `toDocument()` persists.
 */
export declare class RequirementRecord {
    private readonly doc;
    private constructor();
    /** Start a record from the raw dispatched text. */
    static create(id: string, draft: DraftRequirement, createdAt?: string): RequirementRecord;
    /** Restore a record from its persisted document. */
    static load(doc: RequirementDocument): RequirementRecord;
    /** Persistable snapshot. */
    toDocument(): RequirementDocument;
    get status(): RequirementDocument['status'];
    get analysis(): ImpactAnalysis | undefined;
    /** [0] Gate the requirement behind a batch of clarification questions. */
    beginClarification(questions: readonly ClarificationQuestion[]): RequirementRecord;
    /** Record (possibly partial) answers for the open questions. */
    resolveClarification(answers: Readonly<Record<string, string>>): RequirementRecord;
    /** [0]+[1] Attach the completed spec; blocking questions must be answered. */
    attachSpec(spec: RequirementSpec): RequirementRecord;
    /** [2] Analyze the blast radius; requires a spec, uses the graph. */
    analyze(graph: RepoGraphDocument): RequirementRecord;
    /** [3] Attach the per-repo plan set. */
    attachPlans(plans: readonly RepoModificationPlan[]): RequirementRecord;
    /** [5] Mark dispatched, optionally attaching the finished execution run. */
    dispatch(run?: ExecutionRun): RequirementRecord;
    /**
     * Replace the attached run after a submit decision or re-dispatch
     * (16.1): approve turns submit-pending into submitted, reject into
     * needs-human. Only a dispatched record carries a run to replace.
     */
    updateRun(run: ExecutionRun): RequirementRecord;
    /**
     * Return a dispatched requirement to planned for a re-dispatch of its
     * failed repos (17.3 defect loop): the superseded run moves to the
     * append-only runHistory so the failure context survives, and the plans
     * stay attached for the executor to retry against.
     */
    reDispatch(): RequirementRecord;
}
