/**
 * Host web routes for the board UI (docs/product-design.md 7, 14.1).
 *
 * A separate cordis plugin consuming `ctx.repoBoard` plus the host's
 * optional web server (probed structurally, like the tools plugin). Two GET
 * routes serve the current graph and the requirement list; one POST route
 * carries the graph editor's mutation verbs back into the service. Route
 * handlers own the full response lifecycle per the web-server contract.
 * @module dsh-repo-board/web
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name. */
export declare const name = "repo-board-web";
/**
 * The board service must be live before routes register, and the host web
 * server is required - inject declares both, so apply runs only when
 * ctx.webServer exists (on hosts without one the plugin never applies).
 */
export declare const inject: string[];
interface IncomingMessageLike {
    readonly method?: string;
    on(event: 'data', listener: (chunk: Buffer) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
}
interface ServerResponseLike {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
}
/** One named route registration (structural mirror of the host's WebRoute). */
export interface WebRoute {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: (req: IncomingMessageLike, res: ServerResponseLike) => void | Promise<void>;
}
/** Register the board routes when the host provides a web server. */
export declare function apply(ctx: Context): void;
export {};
