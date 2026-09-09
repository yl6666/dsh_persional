/**
 * dsh-repo-board - multi-repo collaborative development plugin for the
 * DeepSeek Harness (docs/product-design.md).
 *
 * The default export is the Cordis service plugin: instantiating it
 * registers `ctx.repoBoard` (scan, graph persistence, queries, manual
 * edits). The pure domain core stays importable from `dsh-repo-board/core`
 * without any host dependencies.
 * @module dsh-repo-board
 */

export {
  RepoGraphStore,
  validateRepoGraphDocument,
} from './graph/store.ts'
export type {
  AutoEdgeInput,
  ManualEdgeInput,
  MergeReport,
} from './graph/store.ts'
export type { RepoGraphDocument, RepoNode, RepoEdge, RepoEdgeType } from './graph/types.ts'
export { edgeId } from './graph/types.ts'
export {
  analyzeImpact,
  effectiveAnswers,
  blockingAnswersComplete,
  planConflicts,
  planDownstream,
  reviewFindings,
  RequirementRecord,
  scaffoldPlans,
} from './pipeline/flow.ts'
export type { ReviewFindings } from './pipeline/flow.ts'
export type {
  ClarificationQuestion,
  ClarificationSession,
  CriticalEdge,
  DraftRequirement,
  ExecutionRun,
  ImpactAnalysis,
  RepoModificationPlan,
  RequirementDocument,
  RequirementSpec,
} from './pipeline/types.ts'
export { RepoBoardService } from './service.ts'
export type { RepoRef } from './service.ts'
export { default } from './service.ts'
