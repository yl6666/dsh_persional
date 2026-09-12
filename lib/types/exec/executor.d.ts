/**
 * Topological plan executor - steps [5]-[6] of the dispatch pipeline
 * (docs/product-design.md 6, 13.3).
 *
 * Schedules one task per repo plan, upstream first: a repo runs only after
 * all its plan prerequisites succeeded. Repos in the same readiness batch
 * run in parallel under an optional concurrency cap. A failure or
 * needs-human outcome blocks every transitive dependent instead of running
 * it half-cocked; prerequisite cycles are surfaced for human review rather
 * than deadlocking. The task itself is injected - the DSH binding runs one
 * session per repo (6), tests run fakes.
 * @module dsh-repo-board
 */
import type { RepoModificationPlan, ExecutionRun } from '../pipeline/types.ts';
/** What one repo task may report back. */
export type RepoTaskOutcome = {
    state: 'succeeded';
    commit?: string;
    diffSummary?: string;
    sessionId?: string;
} | {
    state: 'failed';
    error: string;
    sessionId?: string;
} | {
    state: 'needs-human';
    reason: string;
    sessionId?: string;
};
/** Context handed to one repo task. */
export interface RepoTaskContext {
    readonly plan: RepoModificationPlan;
    /** Local checkout path when known from the graph. */
    readonly repoPath?: string;
    /** Requirement branch the executor has prepared (blank when none). */
    readonly branch: string;
    /** 1-based attempt number; a retry carries the failure history (17.3). */
    readonly attempt: number;
    readonly previousErrors: readonly string[];
}
/** The injected per-repo worker (one DSH session per repo in production). */
export type RepoTask = (context: RepoTaskContext) => Promise<RepoTaskOutcome>;
/**
 * The git seam the executor needs for branch discipline and the submit gate
 * (16.1); satisfied structurally by GitClient, faked in tests.
 */
export interface RepoGitGateway {
    isRepo(cwd: string): Promise<boolean>;
    checkoutBranch(cwd: string, branch: string): Promise<void>;
    currentBranch(cwd: string): Promise<string>;
    listChangedFiles(cwd: string): Promise<string[]>;
    commitAll(cwd: string, message: string): Promise<string>;
}
/** Options for one execution run. */
export interface ExecutePlansOptions {
    /** repo key -> local checkout path. */
    readonly repoPaths?: Readonly<Record<string, string>>;
    /** Parallel cap within one readiness batch; default: whole batch. */
    readonly concurrency?: number;
    /** Branch base; effective branch = plan.branch ?? base + '/' + plan.repo. */
    readonly branchBase?: string;
    /** Who commits: the session itself (auto, default) or a human after the gate (manual). */
    readonly commitPolicy?: 'auto' | 'manual';
    /** Git operations for branch checkout and host-side commits; enables branch discipline. */
    readonly git?: RepoGitGateway;
    /** Attempts per repo before giving up (17.3 loop cap); default 1. */
    readonly maxAttempts?: number;
    /**
     * Failure history per repo from a previous run (re-dispatch, 17.3): seeds
     * previousErrors so the retry prompt carries what went wrong, and the
     * attempt counter continues where the previous run stopped.
     */
    readonly history?: Readonly<Record<string, readonly string[]>>;
}
/**
 * Execute a plan set in dependency order and assemble the ExecutionRun.
 * Never throws for task failures - they land in the run's errors and block
 * dependents.
 */
export declare function executePlans(plans: readonly RepoModificationPlan[], task: RepoTask, options?: ExecutePlansOptions): Promise<ExecutionRun>;
