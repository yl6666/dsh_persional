/**
 * Manifest extractor - the deterministic first stage of the three-tier
 * extraction pipeline (docs/product-design.md 4.3).
 *
 * Pure functions over file contents: no filesystem, no network. The caller
 * reads manifest files and hands them in as a path -> content record; this
 * module parses them per ecosystem and resolves declared dependencies into
 * build edges over the repo group. Production dependencies only - dev/test
 * dependencies are excluded to keep the coupling signal clean.
 * @module dsh-repo-board
 */
import type { AutoEdgeInput } from '../graph/store.ts';
/** Package ecosystems whose manifests the extractor understands. */
export type Ecosystem = 'npm' | 'go' | 'cargo' | 'maven' | 'pypi' | 'gem' | 'composer';
/** One package identity inside an ecosystem. */
export interface PackageName {
    readonly ecosystem: Ecosystem;
    readonly name: string;
}
/** One declared dependency on a package. */
export interface DependencyDeclaration extends PackageName {
    readonly versionConstraint?: string;
}
/** The parsed view of one repo directory's manifests. */
export interface ManifestScanResult {
    readonly repo: string;
    /** Package names this repo provides (its own coordinates). */
    readonly provides: readonly PackageName[];
    /** Declared production dependencies. */
    readonly dependsOn: readonly DependencyDeclaration[];
    /** Build systems detected, e.g. ['npm', 'go']. */
    readonly buildSystems: readonly string[];
}
/** Top-level manifest files the caller should read for one repo. */
export declare const MANIFEST_FILES: readonly string[];
/**
 * Parse one repo directory's manifests. `files` maps relative paths to
 * contents; only the known manifest files (plus `*.gemspec`) are consumed.
 * Malformed JSON manifests throw - the extractor fails loud (design 4.3).
 */
export declare function parseManifests(repo: string, files: Readonly<Record<string, string>>): ManifestScanResult;
/**
 * Resolve declared dependencies across the repo group into build edges.
 * A dependency resolves when another repo in the group provides the same
 * (ecosystem, name). Self-edges are skipped; a from-to pair deduplicates to
 * its first declaration.
 */
export declare function buildEdgesFromManifests(scans: readonly ManifestScanResult[]): AutoEdgeInput[];
/**
 * Deterministic content fingerprint over the given files (FNV-1a, 64-bit).
 * Sorts paths so the hash is independent of directory iteration order;
 * used to skip unchanged repos during incremental rescans (design 4.4).
 */
export declare function contentFingerprint(files: Readonly<Record<string, string>>): string;
