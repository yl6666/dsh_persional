/**
 * RepoGraph domain types - the durable data form of the multi-repo
 * relationship graph (docs/product-design.md 13.1).
 *
 * Direction convention (13.2, single source of truth): an edge `A -> B`
 * asserts that A depends on B - A is the downstream consumer and B is the
 * upstream provider.
 * @module dsh-repo-board
 */
/** Relationship layer of one edge, from deterministic to semantic (4.1). */
export type RepoEdgeType = 'build' | 'code' | 'contract' | 'semantic';
/** Kinds of concrete contracts a contract edge may reference (13.1). */
export type ContractKind = 'event' | 'api' | 'table' | 'schema' | 'rpc' | 'topic' | 'other';
/** One concrete contract reference carried by a contract edge. */
export interface ContractRef {
    /** Contract classification. */
    readonly kind: ContractKind;
    /** Stable contract name, e.g. `order.cancelled`, `POST /orders`, `orders` table. */
    readonly name: string;
    /** Contract content or pointer (schema text, file path, registry URL). */
    readonly schema?: string;
}
/** Where an edge came from - decides the merge strategy (7.1). */
export type RepoEdgeSource = 'auto' | 'manual';
/** Lifecycle status of an edge (13.1); suppressed edges never traverse. */
export type RepoEdgeStatus = 'candidate' | 'confirmed' | 'suppressed';
/** One directed relationship between two repos. */
export interface RepoEdge {
    /** Deterministic identity derived from (from, to, type, contractRef.name). */
    readonly id: string;
    /** Repo key of the downstream consumer - depends on {@link to}. */
    readonly from: string;
    /** Repo key of the upstream provider. */
    readonly to: string;
    /** Relationship layer. */
    readonly type: RepoEdgeType;
    /** Concrete contract reference; contract edges only. */
    readonly contractRef?: ContractRef;
    /** Confidence in [0, 1]. */
    readonly strength: number;
    /** Whether the edge was auto-extracted or human-drawn. */
    readonly source: RepoEdgeSource;
    /** Lifecycle status. */
    readonly status: RepoEdgeStatus;
    /** Version constraint, e.g. `>=1.2`. */
    readonly versionConstraint?: string;
}
/** One repo node. Keyed by a stable id (remote URL or canonical path), never the display name. */
export interface RepoNode {
    /** Display name. */
    readonly name: string;
    /** Local checkout path, when the repo is cloned. */
    readonly path?: string;
    /** Remote URL. */
    readonly remote?: string;
    /** Responsibility labels (LLM-generated, human-editable). */
    readonly labels: readonly string[];
    /** Content hash over manifest + contract files; drives incremental rescans. */
    readonly fingerprint?: string;
    /** Free-form display metadata: stack, language, build system. */
    readonly meta?: Readonly<Record<string, string | readonly string[]>>;
}
/** A human suppression mark: auto analysis must not re-suggest this relation. */
export interface SuppressedEdge {
    readonly from: string;
    readonly to: string;
    readonly type: RepoEdgeType;
    readonly reason?: string;
}
/** The versioned, persistable graph document (13.1). */
export interface RepoGraphDocument {
    readonly version: 1;
    readonly project: string;
    readonly updatedAt: string;
    readonly nodes: Readonly<Record<string, RepoNode>>;
    readonly edges: readonly RepoEdge[];
    readonly suppressed: readonly SuppressedEdge[];
}
/** Derive the deterministic edge id from its identity tuple. */
export declare function edgeId(from: string, to: string, type: RepoEdgeType, contractName?: string): string;
