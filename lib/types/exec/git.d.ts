/**
 * Git wrapper - the only module that talks to the git binary
 * (docs/product-design.md 6, 14.5).
 *
 * All shell-outs go through an injectable {@link CommandRunner} seam so tests
 * drive a fake and the production runner stays a thin child_process wrapper.
 * Commits carry per-invocation identity overrides so the executor works on
 * machines without a global git identity.
 * @module dsh-repo-board
 */
/** One finished process run. */
export interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}
/** Injectable process runner: executes a command in a working directory. */
export interface CommandRunner {
    run(command: string, args: readonly string[], cwd: string): Promise<RunResult>;
}
/** Status slices we care about for one repo checkout. */
export interface GitStatus {
    readonly branch: string;
    readonly ahead: number;
    readonly behind: number;
    readonly staged: readonly string[];
    readonly modified: readonly string[];
    readonly untracked: readonly string[];
    readonly clean: boolean;
}
/** Commit identity used for -c overrides. */
export interface GitIdentity {
    readonly name: string;
    readonly email: string;
}
/** True when `branch` is a protected trunk branch no AI change may touch. */
export declare function isProtectedBranch(branch: string): boolean;
/** Git operations for one host, against any number of checkouts. */
export declare class GitClient {
    private readonly runner;
    private readonly identity;
    constructor(runner: CommandRunner, identity?: GitIdentity);
    private git;
    private require;
    /** True when `cwd` sits inside a git work tree. */
    isRepo(cwd: string): Promise<boolean>;
    /** Current branch name; symbolic-ref works on an unborn HEAD too. */
    currentBranch(cwd: string): Promise<string>;
    /** Porcelain status summary (untracked files fully expanded, no dir folding). */
    status(cwd: string): Promise<GitStatus>;
    /** Files changed vs `base` (or vs HEAD for staged+worktree changes). */
    listChangedFiles(cwd: string, base?: string): Promise<string[]>;
    /** Stage everything and commit with the board identity. Returns the new hash. */
    commitAll(cwd: string, message: string): Promise<string>;
    /** Create-or-reset `branch` and check it out; refuses protected names (6.2). */
    checkoutBranch(cwd: string, branch: string): Promise<void>;
    /** Push the current branch to its upstream (or `origin HEAD` when unset). */
    push(cwd: string, branch?: string): Promise<void>;
    /** Clone `url` into `dir`; returns nothing on success. */
    clone(url: string, dir: string): Promise<void>;
}
/** Production runner over node:child_process. Spawns are inherit-stdio free. */
export declare class NodeCommandRunner implements CommandRunner {
    run(command: string, args: readonly string[], cwd: string): Promise<RunResult>;
}
