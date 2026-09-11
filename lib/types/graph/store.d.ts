/**
 * RepoGraph store - the in-memory builder and persistence form for the
 * multi-repo relationship graph (docs/product-design.md 13.1).
 *
 * Merge strategy (7.1): manual+confirmed edges are never overwritten by auto
 * merges; suppressed relations are never resurrected; everything an auto
 * extractor observes arrives through mergeAutoEdges and lands as candidates.
 * @module dsh-repo-board
 */
import type { ContractRef, RepoEdge, RepoEdgeType, RepoGraphDocument, RepoNode, SuppressedEdge } from './types.ts';
/** One auto-extracted relation offered to the merge strategy. */
export interface AutoEdgeInput {
    readonly from: string;
    readonly to: string;
    readonly type: RepoEdgeType;
    readonly contractRef?: ContractRef;
    readonly strength?: number;
    readonly versionConstraint?: string;
}
/** Input shape for a human-drawn edge. */
export interface ManualEdgeInput {
    readonly from: string;
    readonly to: string;
    readonly type: RepoEdgeType;
    readonly contractRef?: ContractRef;
    readonly versionConstraint?: string;
}
/** Outcome of one mergeAutoEdges run. */
export interface MergeReport {
    readonly added: readonly RepoEdge[];
    readonly updated: readonly RepoEdge[];
    readonly skippedManual: number;
    readonly skippedSuppressed: number;
}
/** Validate the structure of a persisted graph document. Throws TypeError on malformed input. */
export declare function validateRepoGraphDocument(value: unknown): asserts value is RepoGraphDocument;
/**
 * In-memory RepoGraph builder. Owns the mutation surface; every read returns
 * detached immutable data. Persistence (reading/writing the JSON document)
 * belongs to callers - the store never touches the filesystem.
 */
export declare class RepoGraphStore {
    readonly project: string;
    private readonly nodes;
    private readonly edges;
    private readonly suppressed;
    private constructor();
    /** Create an empty graph for one project (one related repo group, 12-1). */
    static create(project: string): RepoGraphStore;
    /** Restore a store from a validated document. */
    static load(doc: RepoGraphDocument): RepoGraphStore;
    /** Detached snapshot of the whole graph. */
    toDocument(now?: string): RepoGraphDocument;
    /** Insert or replace one repo node. */
    upsertNode(key: string, node: RepoNode): void;
    /** Remove one node and every incident edge. Suppression marks are left alone. */
    removeNode(key: string): void;
    getNode(key: string): RepoNode | undefined;
    listNodeKeys(): string[];
    getEdge(id: string): RepoEdge | undefined;
    listEdges(): RepoEdge[];
    listSuppressed(): SuppressedEdge[];
    /**
     * Draw one edge by hand: upserts as source=manual, status=confirmed and
     * clears any suppression mark for the relation (7.1: manual wins).
     */
    addManualEdge(input: ManualEdgeInput): RepoEdge;
    /** Mark one edge suppressed and remember why (13.1 suppressed list). */
    suppressEdge(id: string, reason?: string): void;
    /** Confirm one edge and clear its suppression mark. */
    confirmEdge(id: string): void;
    /** Drop one edge entirely, keeping any suppression mark. */
    removeEdge(id: string): void;
    /** Suppress a whole relation even when no edge for it exists yet. */
    suppressRelation(from: string, to: string, type: RepoEdgeType, reason?: string): void;
    /**
     * Merge auto-extracted observations (7.1 merge strategy):
     * - suppressed relations are skipped (never resurrected);
     * - manual edges are skipped (never overwritten);
     * - existing auto edges are updated in place;
     * - new relations land as candidates.
     */
    mergeAutoEdges(inputs: Iterable<AutoEdgeInput>): MergeReport;
    private requireNode;
}
