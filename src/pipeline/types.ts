/**
 * Requirement pipeline artifacts - the handoff contracts between the eight
 * dispatch steps (docs/product-design.md 13.3, 5.2, 5.3).
 *
 * Every step of the one-dispatch pipeline consumes and produces only these
 * artifacts, so each step stays independently implementable, testable, and
 * replayable. Pure domain types: no LLM, fs, or host imports.
 * @module dsh-repo-board
 */

/** Optional dispatcher hints attached to the raw requirement text. */
export interface RequirementHint {
  /** Repos the dispatcher believes are involved. */
  readonly candidateRepos?: readonly string[]
  /** Priority for scheduling, when stated. */
  readonly priority?: 'low' | 'normal' | 'high'
  /** Whether breaking contract changes are acceptable. */
  readonly allowBreaking?: boolean
}

/** Step input: the raw requirement as dispatched. */
export interface DraftRequirement {
  readonly text: string
  readonly hint?: RequirementHint
}

/** Question shape for the clarification gate (5.2). */
export interface ClarificationOption {
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

/** How a question is answered in the UI. */
export type ClarificationKind = 'select' | 'multi-select' | 'input' | 'confirm'

/** One structured follow-up question. */
export interface ClarificationQuestion {
  readonly id: string
  readonly text: string
  readonly kind: ClarificationKind
  readonly options?: readonly ClarificationOption[]
  /** Preselected value; used when the dispatcher skips a non-blocking question. */
  readonly default?: string
  /** Blocking questions must be answered before a spec may attach. */
  readonly blocking: boolean
  /** Graph evidence behind the question, shown back to the human. */
  readonly context?: string
}

/** A batch of questions plus the answers, once collected. */
export interface ClarificationSession {
  readonly questions: readonly ClarificationQuestion[]
  readonly answers?: Readonly<Record<string, string>>
}

/** Steps [0]+[1]: the complete requirement spec after clarification. */
export interface RequirementSpec {
  /** Original requirement text plus the merged clarification decisions. */
  readonly text: string
  readonly goals: readonly string[]
  /** Directly involved repos; may name repos not yet in the graph. */
  readonly candidateRepos: readonly string[]
  /** Breaking-change / compatibility / timing constraints. */
  readonly constraints: readonly string[]
  readonly acceptance: readonly string[]
}

/** One atomic unit of the execution order (SCC-condensed, 13.2-2). */
export interface ExecutionUnit {
  readonly repos: readonly string[]
  readonly depth: number
  readonly hasContractCycle: boolean
}

/** A cross-repo contract edge that forces human review (13.2-3). */
export interface CriticalEdge {
  readonly from: string
  readonly to: string
  readonly contract?: string
  readonly reason: 'contract' | 'cycle'
}

/** Step [2]: blast-radius analysis over the RepoGraph. */
export interface ImpactAnalysis {
  /** candidateRepos plus every repo reachable backwards from them. */
  readonly affectedRepos: readonly string[]
  /** SCC-condensed units over the affected subgraph, upstream first. */
  readonly topologicalOrder: readonly ExecutionUnit[]
  /** Contract edges inside the affected set and contract cycles. */
  readonly criticalEdges: readonly CriticalEdge[]
  /** Candidate repos that the graph does not know yet (5.2 anomaly). */
  readonly unknownRepos: readonly string[]
}

/** One file/module/function-level change point inside a repo plan (5.3). */
export interface PlanChange {
  /** File, module, or function the change touches. */
  readonly target: string
  readonly description: string
}

/** Contract-boundary review section of a repo plan (5.3). */
export interface PlanContractImpact {
  /** Outward contracts this plan breaks; LLM-declared. */
  readonly breaking: readonly string[]
  /** Downstream repos per contract, looked up from the graph. */
  readonly downstream: readonly { repo: string; via: string }[]
}

/** Step [3]: one repo's structured modification plan (5.3). */
export interface RepoModificationPlan {
  readonly repo: string
  readonly summary: string
  readonly changes: readonly PlanChange[]
  /** Advisory path prefixes this plan intends to write. */
  readonly writeScopes: readonly string[]
  readonly contractImpact: PlanContractImpact
  /** Repos whose plans must finish first (from the graph, upstream first). */
  readonly prerequisites: readonly string[]
  readonly acceptance: readonly string[]
}

/** Per-repo run state for steps [5]-[6]. */
export type RepoRunState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'
  | 'needs-human'

/** One repo's slice of an execution run. */
export interface RepoRunRecord {
  readonly repo: string
  readonly sessionId?: string
  readonly state: RepoRunState
  readonly commit?: string
  readonly diffSummary?: string
}

/** Steps [5]-[6]: the execution run snapshot. */
export interface ExecutionRun {
  readonly perRepo: readonly RepoRunRecord[]
  /** Failures, rollbacks, and items needing human intervention. */
  readonly errors: readonly string[]
}

/** Lifecycle of one dispatched requirement. */
export type RequirementStatus =
  | 'draft'
  | 'clarifying'
  | 'spec-ready'
  | 'analyzed'
  | 'planned'
  | 'dispatched'

/** Persistable requirement record: the artifact chain plus its state. */
export interface RequirementDocument {
  readonly version: 1
  readonly id: string
  readonly createdAt: string
  readonly status: RequirementStatus
  readonly draft: DraftRequirement
  readonly clarification?: ClarificationSession
  readonly spec?: RequirementSpec
  readonly analysis?: ImpactAnalysis
  readonly plans?: readonly RepoModificationPlan[]
  readonly run?: ExecutionRun
}
