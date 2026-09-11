/**
 * Filesystem scanner - reads one repo directory into the pure extractors'
 * input shape (docs/product-design.md 4.3).
 *
 * Walks the directory skipping dependency/build outputs, classifies each
 * text file as manifest, contract, or searchable source, and reads it as
 * UTF-8. Node-only module: kept out of the browser-safe core export.
 * @module dsh-repo-board
 */
/** One repo's files classified for the extraction pipeline. */
export interface ScannedRepoFiles {
    /** Root manifests plus gemspecs, path -> content. */
    readonly manifest: Record<string, string>;
    /** Contract-bearing files, path -> content. */
    readonly contracts: Record<string, string>;
    /** Remaining searchable text files, path -> content. */
    readonly sources: Record<string, string>;
}
/**
 * Walk one repo directory and classify its text files. Manifests are matched
 * by exact root-relative path (`package.json`, `go.mod`, ...) plus any
 * `*.gemspec`; contracts by {@link isContractFile}; everything else lands in
 * sources.
 */
export declare function scanRepoDirectory(dir: string): Promise<ScannedRepoFiles>;
/**
 * Fingerprint over the manifest + contract files (design 4.4): the rescan
 * driver. v0.1 always rescans and merges idempotently; the fingerprint is
 * stored on the node for future skip-if-unchanged optimizations.
 */
export declare function scannedFingerprint(files: ScannedRepoFiles): string;
