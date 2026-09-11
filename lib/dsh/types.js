/**
 * Structural types for the DSH host surface this plugin consumes
 * (docs/product-design.md 8).
 *
 * The published @deepseek-ai/cordis package carries only the base context,
 * and the rc DSH packages are not yet self-contained on npm. Instead of
 * depending on them, these hand-written structural interfaces mirror the
 * exact shapes from the DSH subsystem docs (tools.md, subagent.md); inside a
 * real DSH process the runtime objects satisfy them structurally, and plain
 * cordis hosts simply lack the optional fields.
 * @module dsh-repo-board
 */
/** Read the optional host services off a plain cordis Context. */
export function hostCapabilities(ctx) {
    const holder = ctx;
    const tools = typeof holder.tools === 'object' && holder.tools !== null && 'register' in holder.tools
        ? holder.tools
        : undefined;
    const subagents = typeof holder.subagents === 'object' && holder.subagents !== null && 'start' in holder.subagents
        ? holder.subagents
        : undefined;
    return { tools, subagents };
}
