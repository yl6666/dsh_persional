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
/** Text content block - the structural subset this plugin produces. */
export interface TextBlock {
    readonly type: 'text';
    readonly text: string;
}
/** Minimal content block vocabulary (text only). */
export type ContentBlock = TextBlock;
/** Raw JSON Schema node in DSH's enforced subset (tools.md). */
export interface JsonSchemaNode {
    readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    readonly oneOf?: readonly JsonSchemaNode[];
    readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
    readonly items?: JsonSchemaNode;
    readonly enum?: readonly (string | number | boolean | null)[];
    readonly const?: string | number | boolean | null;
    readonly description?: string;
    readonly title?: string;
}
/** Execution context handed to one tool body. */
export interface ToolRunContext {
    readonly callId: unknown;
    readonly name: string;
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs; the subagent parent. */
    readonly agent?: object;
    readonly signal: AbortSignal;
}
/** Canonical output declaration of one raw tool definition. */
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: unknown): ContentBlock[];
}
/** A raw JSON-Schema tool definition (ctx.tools.register input). */
export interface RawToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaNode;
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    readonly timeoutMs?: number;
}
/** The host's tool registry, when present. */
export interface ToolsRegistryLike {
    register(definition: RawToolDefinition): () => void;
}
/** One finished one-shot subagent run. */
export interface SubagentRunLike {
    readonly id: unknown;
    readonly result: Promise<SubagentResultLike>;
}
/** The structured outcome of one subagent run. */
export interface SubagentResultLike {
    readonly output: readonly ContentBlock[];
    readonly structured?: unknown;
    readonly stopReason: string;
}
/** One-shot subagent start request (subagent.md SubagentStartRequest). */
export interface SubagentStartRequestLike {
    readonly label?: string;
    readonly prompt: readonly ContentBlock[];
    readonly parent: object;
    readonly signal: AbortSignal;
    readonly outputSchema?: JsonSchemaNode;
}
/** The host's subagent runtime, when present. */
export interface SubagentsRuntimeLike {
    start(request: SubagentStartRequestLike): Promise<SubagentRunLike>;
}
/**
 * Runtime host capability probe: which optional DSH services exist on this
 * context. Plain cordis hosts report none.
 */
export interface HostCapabilities {
    readonly tools: ToolsRegistryLike | undefined;
    readonly subagents: SubagentsRuntimeLike | undefined;
}
/** Read the optional host services off a plain cordis Context. */
export declare function hostCapabilities(ctx: object): HostCapabilities;
