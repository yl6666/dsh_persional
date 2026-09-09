/**
 * Pure domain core of dsh-repo-board: the RepoGraph model, algorithms,
 * store, and the pure extraction parsers. Zero runtime dependencies and no
 * node/browser-specific imports - safe to consume from any host.
 * @module dsh-repo-board/core
 */
export * from './graph/index.ts'
export * from './extract/index.ts'
