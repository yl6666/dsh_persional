import { RepoGraphStore } from '../src/graph/store.ts'
import type { RepoGraphDocument } from '../src/graph/types.ts'

export const UPDATED_AT = '2026-01-01T00:00:00.000Z'

function addNodes(store: RepoGraphStore, keys: string[]): void {
  for (const key of keys) store.upsertNode(key, { name: key, labels: [] })
}

/**
 * The acme-checkout example from the design document (5.2): order-service
 * emits `order.cancelled`; notify/audit consume it; everything builds on
 * shared-sdk; web-portal builds on audit-service. Consumer -> provider.
 */
export function acmeGraph(): RepoGraphDocument {
  const store = RepoGraphStore.create('acme-checkout')
  addNodes(store, ['order-service', 'notify-service', 'audit-service', 'shared-sdk', 'web-portal'])
  store.mergeAutoEdges([
    { from: 'order-service', to: 'shared-sdk', type: 'build', strength: 1, versionConstraint: '^1.2.0' },
    { from: 'notify-service', to: 'shared-sdk', type: 'build', strength: 1 },
    { from: 'audit-service', to: 'shared-sdk', type: 'build', strength: 1 },
    { from: 'web-portal', to: 'audit-service', type: 'build', strength: 1 },
    { from: 'notify-service', to: 'order-service', type: 'contract', contractRef: { kind: 'event', name: 'order.cancelled' }, strength: 0.9 },
    { from: 'audit-service', to: 'order-service', type: 'contract', contractRef: { kind: 'event', name: 'order.cancelled' }, strength: 0.9 },
  ])
  return store.toDocument(UPDATED_AT)
}

/** a and b consume each other's contracts; c builds on a. Contract cycle (13.2-3). */
export function cycleGraph(): RepoGraphDocument {
  const store = RepoGraphStore.create('cycles')
  addNodes(store, ['a', 'b', 'c'])
  store.mergeAutoEdges([
    { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'api', name: 'x' } },
    { from: 'b', to: 'a', type: 'contract', contractRef: { kind: 'api', name: 'y' } },
    { from: 'c', to: 'a', type: 'build' },
  ])
  return store.toDocument(UPDATED_AT)
}

/** a and b depend on each other only through build edges - a condensable, non-contract cycle. */
export function buildOnlyCycleGraph(): RepoGraphDocument {
  const store = RepoGraphStore.create('build-cycles')
  addNodes(store, ['a', 'b'])
  store.mergeAutoEdges([
    { from: 'a', to: 'b', type: 'build' },
    { from: 'b', to: 'a', type: 'build' },
  ])
  return store.toDocument(UPDATED_AT)
}

/** A single repo with a contract self-dependency. */
export function selfLoopGraph(): RepoGraphDocument {
  const store = RepoGraphStore.create('self-loop')
  addNodes(store, ['a'])
  store.mergeAutoEdges([{ from: 'a', to: 'a', type: 'contract', contractRef: { kind: 'event', name: 'looped' } }])
  return store.toDocument(UPDATED_AT)
}
