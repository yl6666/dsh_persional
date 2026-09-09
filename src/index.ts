/**
 * dsh-repo-board - multi-repo collaborative development plugin for the
 * DeepSeek Harness (docs/product-design.md).
 *
 * The pure domain core is exported from './core.ts'. This entry additionally
 * carries the Cordis plugin shape consumed by the DSH loader; host-side
 * service registration lands with M2 (design 8).
 * @module dsh-repo-board
 */
export * from './core.ts'

export const name = 'repo-board'

export function apply(): void {
  // M2 (design 8): register ctx.repoGraph, the dispatch pipeline, and the
  // model-facing tools here. Kept as a no-op until the cordis shell lands so
  // the bundle row already loads cleanly.
}
