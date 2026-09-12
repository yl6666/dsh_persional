/**
 * Prompt and schema builders for the one-session-per-repo executor binding
 * (docs/product-design.md 6). Pure functions: fully unit-testable, no host
 * imports.
 * @module dsh-repo-board
 */
import type { JsonSchemaNode } from './types.ts';
import type { RepoModificationPlan, RequirementSpec } from '../pipeline/types.ts';
/** Structured output one repo session is asked to produce. */
export interface RepoSessionOutput {
    readonly summary: string;
    readonly commit?: string;
    readonly changedFiles: readonly string[];
}
/** Output schema sent with the subagent start request. */
export declare const repoSessionOutputSchema: JsonSchemaNode & {
    type: 'object';
};
/**
 * The full brief one repo session receives: the repo's plan in context, the
 * upstream results it may build on, and the reporting contract.
 */
export declare function buildRepoSessionPrompt(input: {
    readonly plan: RepoModificationPlan;
    readonly spec: RequirementSpec;
    readonly repoPath?: string;
    readonly upstreamResults: readonly {
        repo: string;
        summary: string;
        commit?: string;
    }[];
    /** Requirement branch the executor has prepared for this repo. */
    readonly branch?: string;
    /** False when the host commits after human approval; the session must not commit. */
    readonly selfCommit?: boolean;
    /**
     * True when the path is not the root of its own git work tree. Any git
     * command run there resolves into the ENCLOSING repository, so the
     * session must not touch git at all - it just edits files.
     */
    readonly noGit?: boolean;
    /** 1-based attempt number for defect retries. */
    readonly attempt?: number;
    /** Failure history from previous attempts (17.3 defect loop). */
    readonly previousErrors?: readonly string[];
}): string;
/** Render one line of human-facing run narration for a tool result. */
export declare function renderRunLine(run: {
    perRepo: readonly {
        repo: string;
        state: string;
        commit?: string;
    }[];
    errors: readonly string[];
}): string;
