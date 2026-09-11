/**
 * RepoGraph algorithms (docs/product-design.md 13.2).
 *
 * Direction convention (inherited from types.ts): edge `A -> B` means A
 * depends on B. Consequences: dependencies() follows forward edges (what A
 * needs), impact() follows reverse edges (who needs A), and the topological
 * order places upstream providers before downstream consumers.
 * @module dsh-repo-board
 */
import type { RepoEdgeType, RepoGraphDocument } from './types.ts';
/** Options constraining which edges a traversal follows. */
export interface TraversalOptions {
    /** Restrict traversal to these edge types; default: all types. */
    readonly edgeTypes?: readonly RepoEdgeType[];
    /** Only traverse `confirmed` edges; default also follows candidates. */
    readonly confirmedOnly?: boolean;
}
/** Blast-radius report for one repo (13.2 - impact). */
export interface ImpactReport {
    /** The repo the analysis started from. */
    readonly repo: string;
    /** Repos that depend on `repo` through a direct edge. Sorted. */
    readonly direct: readonly string[];
    /** Repos that depend on `repo` only transitively. Sorted. */
    readonly transitive: readonly string[];
    /** Per-edge-type breakdown: repos reachable using only that edge type. */
    readonly byEdgeType: Readonly<Record<RepoEdgeType, readonly string[]>>;
}
/** One scheduling unit after SCC condensation: a repo or an atomic cycle batch. */
export interface TopologicalUnit {
    /** Member repo keys; more than one member (or a self-loop) means an atomic cycle batch. */
    readonly repos: readonly string[];
    /** 0 for units with no upstream inside the subgraph; else 1 + max upstream depth. */
    readonly depth: number;
    /** True when contract edges participate in the cycle - forces human review (13.2-3). */
    readonly hasContractCycle: boolean;
}
/** One task's declared write scopes (advisory path prefixes, 13.2-4). */
export interface RepoTaskScopes {
    readonly repo: string;
    readonly writeScopes: readonly string[];
}
/** A pairwise write-scope overlap between two parallel tasks. */
export interface WriteScopeConflict {
    readonly repoA: string;
    readonly repoB: string;
    /** Overlapping scope pairs, formatted `a <-> b`. */
    readonly overlaps: readonly string[];
}
/** The forward reachable set: everything `repo` depends on (13.2-1). Sorted. */
export declare function dependencies(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): string[];
/** The reverse reachable set: everything that depends on `repo` - the blast radius. Sorted. */
export declare function impact(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): string[];
/** Full blast-radius report: direct vs transitive dependents plus per-type breakdown. */
export declare function impactReport(graph: RepoGraphDocument, repo: string, options?: TraversalOptions): ImpactReport;
/**
 * Topological scheduling units over the induced subgraph of `repos`
 * (default: every node). Upstream first: a unit's depth is one more than the
 * deepest unit it depends on. Cycles condense into atomic batch units
 * (13.2-3); units participate in a contract cycle are flagged for review.
 */
export declare function topologicalUnits(graph: RepoGraphDocument, repos?: readonly string[], options?: TraversalOptions): TopologicalUnit[];
/** Normalize one write scope: backslashes to slashes, collapsed separators, no trailing slash. */
export declare function normalizeScope(scope: string): string;
/**
 * Pairwise write-scope conflicts across parallel tasks (13.2-4). Two scopes
 * overlap when equal or when one is a path-prefix of the other; plain string
 * prefixes without a separator boundary never conflict (`srcx` vs `src`).
 */
export declare function writeScopeConflicts(tasks: readonly RepoTaskScopes[]): WriteScopeConflict[];
