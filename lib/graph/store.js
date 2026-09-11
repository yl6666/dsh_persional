/**
 * RepoGraph store - the in-memory builder and persistence form for the
 * multi-repo relationship graph (docs/product-design.md 13.1).
 *
 * Merge strategy (7.1): manual+confirmed edges are never overwritten by auto
 * merges; suppressed relations are never resurrected; everything an auto
 * extractor observes arrives through mergeAutoEdges and lands as candidates.
 * @module dsh-repo-board
 */
import { edgeId } from "./types.js";
function stripUndefined(value) {
    const record = value;
    for (const key of Object.keys(record)) {
        if (record[key] === undefined)
            delete record[key];
    }
    return value;
}
function detachContractRef(ref) {
    return ref === undefined ? undefined : { ...ref };
}
function suppressionKey(from, to, type) {
    return from + '->' + to + '::' + type;
}
const EDGE_TYPES = ['build', 'code', 'contract', 'semantic'];
const CONTRACT_KINDS = ['event', 'api', 'table', 'schema', 'rpc', 'topic', 'other'];
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireString(holder, field, what) {
    const value = holder[field];
    if (typeof value !== 'string' || value === '') {
        throw new TypeError(what + ': ' + field + ' must be a non-empty string');
    }
    return value;
}
function optionalString(holder, field, what) {
    const value = holder[field];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new TypeError(what + ': ' + field + ' must be a string');
    return value;
}
function validateNode(key, value) {
    const what = 'RepoGraphDocument.nodes[' + JSON.stringify(key) + ']';
    if (!isObject(value))
        throw new TypeError(what + ': expected an object');
    requireString(value, 'name', what);
    optionalString(value, 'path', what);
    optionalString(value, 'remote', what);
    optionalString(value, 'fingerprint', what);
    const labels = value['labels'];
    if (labels !== undefined) {
        if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) {
            throw new TypeError(what + ': labels must be an array of strings');
        }
    }
    const meta = value['meta'];
    if (meta !== undefined) {
        if (!isObject(meta))
            throw new TypeError(what + ': meta must be an object');
        for (const [metaKey, metaValue] of Object.entries(meta)) {
            const ok = typeof metaValue === 'string' ||
                (Array.isArray(metaValue) && metaValue.every(item => typeof item === 'string'));
            if (!ok)
                throw new TypeError(what + ': meta[' + JSON.stringify(metaKey) + '] must be a string or string array');
        }
    }
}
function validateEdge(value, nodeKeys) {
    const what = 'RepoGraphDocument.edges[]';
    if (!isObject(value))
        throw new TypeError(what + ': expected an object');
    const id = requireString(value, 'id', what);
    const from = requireString(value, 'from', what);
    const to = requireString(value, 'to', what);
    const type = requireString(value, 'type', what);
    if (!EDGE_TYPES.includes(type))
        throw new TypeError(what + ': unknown type ' + JSON.stringify(type));
    if (!nodeKeys.has(from))
        throw new TypeError(what + ': unknown from repo ' + JSON.stringify(from));
    if (!nodeKeys.has(to))
        throw new TypeError(what + ': unknown to repo ' + JSON.stringify(to));
    const source = requireString(value, 'source', what);
    if (source !== 'auto' && source !== 'manual') {
        throw new TypeError(what + ': source must be auto or manual');
    }
    const status = requireString(value, 'status', what);
    if (status !== 'candidate' && status !== 'confirmed' && status !== 'suppressed') {
        throw new TypeError(what + ': status must be candidate, confirmed, or suppressed');
    }
    const strength = value['strength'];
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) {
        throw new TypeError(what + ': strength must be a number in [0, 1]');
    }
    optionalString(value, 'versionConstraint', what);
    const ref = value['contractRef'];
    let contractName;
    if (ref !== undefined) {
        if (!isObject(ref))
            throw new TypeError(what + ': contractRef must be an object');
        const kind = requireString(ref, 'kind', what + ' contractRef');
        if (!CONTRACT_KINDS.includes(kind)) {
            throw new TypeError(what + ': unknown contractRef.kind ' + JSON.stringify(kind));
        }
        contractName = requireString(ref, 'name', what + ' contractRef');
        optionalString(ref, 'schema', what + ' contractRef');
    }
    const expected = edgeId(from, to, type, contractName);
    if (id !== expected) {
        throw new TypeError(what + ': id ' + JSON.stringify(id) + ' does not match identity ' + JSON.stringify(expected));
    }
}
function validateSuppressed(value) {
    const what = 'RepoGraphDocument.suppressed[]';
    if (!isObject(value))
        throw new TypeError(what + ': expected an object');
    requireString(value, 'from', what);
    requireString(value, 'to', what);
    const type = requireString(value, 'type', what);
    if (!EDGE_TYPES.includes(type))
        throw new TypeError(what + ': unknown type ' + JSON.stringify(type));
    optionalString(value, 'reason', what);
}
/** Validate the structure of a persisted graph document. Throws TypeError on malformed input. */
export function validateRepoGraphDocument(value) {
    if (!isObject(value))
        throw new TypeError('RepoGraphDocument: expected an object');
    if (value['version'] !== 1) {
        throw new TypeError('RepoGraphDocument: unsupported version ' + JSON.stringify(value['version']));
    }
    requireString(value, 'project', 'RepoGraphDocument');
    requireString(value, 'updatedAt', 'RepoGraphDocument');
    const nodes = value['nodes'];
    if (!isObject(nodes))
        throw new TypeError('RepoGraphDocument.nodes: expected an object');
    for (const [key, node] of Object.entries(nodes))
        validateNode(key, node);
    const nodeKeys = new Set(Object.keys(nodes));
    const edges = value['edges'];
    if (!Array.isArray(edges))
        throw new TypeError('RepoGraphDocument.edges: expected an array');
    for (const edge of edges)
        validateEdge(edge, nodeKeys);
    const suppressed = value['suppressed'];
    if (!Array.isArray(suppressed))
        throw new TypeError('RepoGraphDocument.suppressed: expected an array');
    for (const mark of suppressed)
        validateSuppressed(mark);
}
/**
 * In-memory RepoGraph builder. Owns the mutation surface; every read returns
 * detached immutable data. Persistence (reading/writing the JSON document)
 * belongs to callers - the store never touches the filesystem.
 */
export class RepoGraphStore {
    project;
    nodes = new Map();
    edges = new Map();
    suppressed = new Map();
    constructor(project) {
        this.project = project;
    }
    /** Create an empty graph for one project (one related repo group, 12-1). */
    static create(project) {
        if (project === '')
            throw new TypeError('project must be a non-empty string');
        return new RepoGraphStore(project);
    }
    /** Restore a store from a validated document. */
    static load(doc) {
        validateRepoGraphDocument(doc);
        const store = new RepoGraphStore(doc.project);
        for (const [key, node] of Object.entries(doc.nodes))
            store.nodes.set(key, node);
        for (const edge of doc.edges)
            store.edges.set(edge.id, edge);
        for (const mark of doc.suppressed) {
            store.suppressed.set(suppressionKey(mark.from, mark.to, mark.type), mark);
        }
        return store;
    }
    /** Detached snapshot of the whole graph. */
    toDocument(now = new Date().toISOString()) {
        const nodes = {};
        for (const [key, node] of this.nodes) {
            nodes[key] = stripUndefined({
                ...node,
                labels: [...node.labels],
                meta: node.meta === undefined ? undefined : { ...node.meta },
            });
        }
        return {
            version: 1,
            project: this.project,
            updatedAt: now,
            nodes,
            edges: [...this.edges.values()].map(edge => stripUndefined({ ...edge, contractRef: detachContractRef(edge.contractRef) })),
            suppressed: [...this.suppressed.values()].map(mark => stripUndefined({ ...mark })),
        };
    }
    /** Insert or replace one repo node. */
    upsertNode(key, node) {
        if (key === '')
            throw new TypeError('node key must be a non-empty string');
        this.nodes.set(key, stripUndefined({
            ...node,
            labels: [...node.labels],
            meta: node.meta === undefined ? undefined : { ...node.meta },
        }));
    }
    /** Remove one node and every incident edge. Suppression marks are left alone. */
    removeNode(key) {
        if (!this.nodes.delete(key))
            return;
        for (const [id, edge] of this.edges) {
            if (edge.from === key || edge.to === key)
                this.edges.delete(id);
        }
    }
    getNode(key) {
        return this.nodes.get(key);
    }
    listNodeKeys() {
        return [...this.nodes.keys()].sort();
    }
    getEdge(id) {
        return this.edges.get(id);
    }
    listEdges() {
        return [...this.edges.values()];
    }
    listSuppressed() {
        return [...this.suppressed.values()];
    }
    /**
     * Draw one edge by hand: upserts as source=manual, status=confirmed and
     * clears any suppression mark for the relation (7.1: manual wins).
     */
    addManualEdge(input) {
        this.requireNode(input.from);
        this.requireNode(input.to);
        const edge = stripUndefined({
            id: edgeId(input.from, input.to, input.type, input.contractRef?.name),
            from: input.from,
            to: input.to,
            type: input.type,
            contractRef: detachContractRef(input.contractRef),
            strength: 1,
            source: 'manual',
            status: 'confirmed',
            versionConstraint: input.versionConstraint,
        });
        this.edges.set(edge.id, edge);
        this.suppressed.delete(suppressionKey(edge.from, edge.to, edge.type));
        return edge;
    }
    /** Mark one edge suppressed and remember why (13.1 suppressed list). */
    suppressEdge(id, reason) {
        const edge = this.edges.get(id);
        if (edge === undefined)
            return;
        const next = stripUndefined({ ...edge, status: 'suppressed' });
        this.edges.set(id, next);
        this.suppressed.set(suppressionKey(edge.from, edge.to, edge.type), {
            from: edge.from,
            to: edge.to,
            type: edge.type,
            reason,
        });
    }
    /** Confirm one edge and clear its suppression mark. */
    confirmEdge(id) {
        const edge = this.edges.get(id);
        if (edge === undefined)
            return;
        this.edges.set(id, stripUndefined({ ...edge, status: 'confirmed' }));
        this.suppressed.delete(suppressionKey(edge.from, edge.to, edge.type));
    }
    /** Drop one edge entirely, keeping any suppression mark. */
    removeEdge(id) {
        this.edges.delete(id);
    }
    /** Suppress a whole relation even when no edge for it exists yet. */
    suppressRelation(from, to, type, reason) {
        this.suppressed.set(suppressionKey(from, to, type), { from, to, type, reason });
    }
    /**
     * Merge auto-extracted observations (7.1 merge strategy):
     * - suppressed relations are skipped (never resurrected);
     * - manual edges are skipped (never overwritten);
     * - existing auto edges are updated in place;
     * - new relations land as candidates.
     */
    mergeAutoEdges(inputs) {
        const added = [];
        const updated = [];
        let skippedManual = 0;
        let skippedSuppressed = 0;
        for (const input of inputs) {
            this.requireNode(input.from);
            this.requireNode(input.to);
            if (this.suppressed.has(suppressionKey(input.from, input.to, input.type))) {
                skippedSuppressed += 1;
                continue;
            }
            const id = edgeId(input.from, input.to, input.type, input.contractRef?.name);
            const existing = this.edges.get(id);
            const strength = input.strength ?? 0.5;
            if (existing === undefined) {
                const edge = stripUndefined({
                    id,
                    from: input.from,
                    to: input.to,
                    type: input.type,
                    contractRef: detachContractRef(input.contractRef),
                    strength,
                    source: 'auto',
                    status: 'candidate',
                    versionConstraint: input.versionConstraint,
                });
                this.edges.set(id, edge);
                added.push(edge);
            }
            else if (existing.status === 'suppressed') {
                skippedSuppressed += 1;
            }
            else if (existing.source === 'manual') {
                skippedManual += 1;
            }
            else {
                const next = stripUndefined({
                    ...existing,
                    strength,
                    contractRef: detachContractRef(input.contractRef) ?? existing.contractRef,
                    versionConstraint: input.versionConstraint ?? existing.versionConstraint,
                });
                this.edges.set(id, next);
                updated.push(next);
            }
        }
        return { added, updated, skippedManual, skippedSuppressed };
    }
    requireNode(key) {
        if (!this.nodes.has(key))
            throw new TypeError('unknown repo: ' + key);
    }
}
