/**
 * Model-facing tools for the multi-repo board (docs/product-design.md 8, M4.5).
 *
 * A separate cordis plugin from the service: it consumes `ctx.repoBoard`
 * plus the host's optional tool registry and subagent runtime through
 * hand-rolled structural types (dsh/types.ts), so the package installs with
 * only the base cordis peer dependency. Raw JSON-Schema tool definitions own
 * their argument validation (tools.md), hence the strict parse helpers.
 *
 * Tool set - the eight dispatch steps as model calls:
 * - repo_board_scan: open + scan a repo group into the graph
 * - repo_board_graph: impact / dependencies / topology queries
 * - repo_board_dispatch: register the raw requirement (draft)
 * - repo_board_clarify: record one clarification batch and its answers ([0])
 * - repo_board_spec: attach the spec, analyze, scaffold plans ([0]-[3])
 * - repo_board_plans: attach filled plans + review findings ([3]-[4])
 * - repo_board_execute: one subagent session per repo, upstream first ([5]-[6])
 * - repo_board_submit: human submit gate for manual commit policy (16.1)
 * @module dsh-repo-board/tools
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name. */
export declare const name = "repo-board-tools";
/**
 * The board service must be live before tools register, and the host's tool
 * registry is required - inject declares it, so apply runs only when
 * ctx.tools exists (real cordis throws on undeclared service reads).
 */
export declare const inject: string[];
/** Register the model-facing tools when the host provides a registry. */
export declare function apply(ctx: Context): void;
