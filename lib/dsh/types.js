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
/** Default in-process subagent provider on the web host (spawn/fork). */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn';
/** Read one optional host service: ctx.get first, plain property second. */
function readService(ctx, name) {
    const holder = ctx;
    if (typeof holder.get === 'function') {
        try {
            const viaGet = holder.get(name);
            if (viaGet !== undefined)
                return viaGet;
        }
        catch {
            // Not provided (or not yet) - fall through to the property probe.
        }
    }
    return holder[name];
}
/** Read the optional host services off any cordis-like context. */
export function hostCapabilities(ctx) {
    const tools = readService(ctx, 'tools');
    const subagents = readService(ctx, 'subagents');
    return {
        tools: typeof tools === 'object' && tools !== null && 'register' in tools
            ? tools
            : undefined,
        subagents: typeof subagents === 'object' && subagents !== null && 'start' in subagents
            ? subagents
            : undefined,
    };
}
