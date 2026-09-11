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
export { RepoGraphStore, validateRepoGraphDocument, } from "./graph/store.js";
export { edgeId } from "./graph/types.js";
export { analyzeImpact, effectiveAnswers, blockingAnswersComplete, planConflicts, planDownstream, reviewFindings, RequirementRecord, scaffoldPlans, } from "./pipeline/flow.js";
export { RepoBoardService } from "./service.js";
export { executePlans } from "./exec/executor.js";
export { GitClient, NodeCommandRunner } from "./exec/git.js";
export { default } from "./service.js";
