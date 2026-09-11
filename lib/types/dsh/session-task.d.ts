/**
 * The RepoTask binding that runs one DSH subagent session per repo
 * (docs/product-design.md 6, 12 - subagents first).
 *
 * Each repo plan becomes one one-shot subagent with a structured-output
 * schema; the session works inside the repo checkout and commits. The
 * binding maps the subagent outcome onto the executor's RepoTaskOutcome.
 * @module dsh-repo-board
 */
import type { RepoTask } from '../exec/executor.ts';
import type { RequirementSpec } from '../pipeline/types.ts';
import type { SubagentsRuntimeLike } from './types.ts';
/** Result summaries of already-finished upstream repo sessions. */
export interface UpstreamResult {
    readonly repo: string;
    readonly summary: string;
    readonly commit?: string;
}
/** Options for {@link buildRepoSessionTask}. */
export interface RepoSessionTaskOptions {
    readonly subagents: SubagentsRuntimeLike;
    readonly parent: object;
    readonly spec: RequirementSpec;
    /** Collects finished upstream results so later repos can build on them. */
    readonly upstream: {
        results: UpstreamResult[];
    };
    readonly signal: AbortSignal;
    /** False when the host commits after human approval; the session must not commit. */
    readonly selfCommit?: boolean;
}
/**
 * Build the per-repo task that spawns one subagent session per plan. The
 * label and prompt derive purely from the plan; upstream results flow into
 * later prompts through the shared collector.
 */
export declare function buildRepoSessionTask(options: RepoSessionTaskOptions): RepoTask;
