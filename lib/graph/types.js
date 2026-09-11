/**
 * RepoGraph domain types - the durable data form of the multi-repo
 * relationship graph (docs/product-design.md 13.1).
 *
 * Direction convention (13.2, single source of truth): an edge `A -> B`
 * asserts that A depends on B - A is the downstream consumer and B is the
 * upstream provider.
 * @module dsh-repo-board
 */
/** Derive the deterministic edge id from its identity tuple. */
export function edgeId(from, to, type, contractName) {
    const contract = contractName === undefined ? '' : '::' + contractName;
    return from + '->' + to + '::' + type + contract;
}
