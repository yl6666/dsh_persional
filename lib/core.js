/**
 * Pure domain core of dsh-repo-board: the RepoGraph model, algorithms,
 * store, the pure extraction parsers, and the requirement pipeline
 * artifacts. Zero runtime dependencies and no node/browser-specific
 * imports - safe to consume from any host.
 * @module dsh-repo-board/core
 */
export * from "./graph/index.js";
export * from "./extract/index.js";
export * from "./pipeline/flow.js";
export * from "./pipeline/types.js";
export * from "./exec/executor.js";
