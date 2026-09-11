/**
 * Pure domain core of dsh-repo-board: the RepoGraph model, algorithms,
 * store, the pure extraction parsers, and the requirement pipeline
 * artifacts. Zero runtime dependencies and no node/browser-specific
 * imports - safe to consume from any host.
 * @module dsh-repo-board/core
 */
export * from './graph/index.ts';
export * from './extract/index.ts';
export * from './pipeline/flow.ts';
export * from './pipeline/types.ts';
export * from './exec/executor.ts';
