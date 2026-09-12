import { describe, expect, it } from 'vitest'
import { RepoGraphStore, validateRepoGraphDocument } from '../src/graph/store.ts'
import type { RepoGraphDocument } from '../src/graph/types.ts'
import { edgeId } from '../src/graph/types.ts'
import { acmeGraph, UPDATED_AT } from './fixtures.ts'

function seededStore(): RepoGraphStore {
  const store = RepoGraphStore.create('p')
  for (const key of ['a', 'b']) store.upsertNode(key, { name: key, labels: [] })
  return store
}

describe('RepoGraphStore documents (13.1)', () => {
  it('roundtrips through a document and through JSON', () => {
    const doc = acmeGraph()
    expect(RepoGraphStore.load(doc).toDocument(doc.updatedAt)).toStrictEqual(doc)
    const json = JSON.parse(JSON.stringify(doc)) as RepoGraphDocument
    expect(RepoGraphStore.load(json).toDocument(doc.updatedAt)).toStrictEqual(doc)
  })

  it('documents never carry explicit undefined keys', () => {
    const doc = acmeGraph()
    expect(JSON.stringify(doc)).not.toContain('undefined')
    for (const edge of doc.edges) {
      if (edge.type !== 'contract') expect('contractRef' in edge).toBe(false)
    }
  })

  it('removeNode drops incident edges but keeps the rest', () => {
    const store = RepoGraphStore.load(acmeGraph())
    store.removeNode('order-service')
    const doc = store.toDocument(UPDATED_AT)
    expect(Object.keys(doc.nodes).sort()).toEqual(['audit-service', 'notify-service', 'shared-sdk', 'web-portal'])
    expect(doc.edges).toHaveLength(3)
    expect(doc.edges.every(e => e.from !== 'order-service' && e.to !== 'order-service')).toBe(true)
  })
})

describe('merge strategy (7.1)', () => {
  it('auto edges land as candidates and update in place on re-observation', () => {
    const store = seededStore()
    const first = store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build', strength: 0.5 }])
    expect(first.added).toHaveLength(1)
    expect(first.updated).toHaveLength(0)
    expect(first.added[0]!.source).toBe('auto')
    expect(first.added[0]!.status).toBe('candidate')
    expect(first.added[0]!.strength).toBe(0.5)

    const second = store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build', strength: 0.9 }])
    expect(second.added).toHaveLength(0)
    expect(second.updated).toHaveLength(1)
    expect(second.updated[0]!.strength).toBe(0.9)
    expect(store.listEdges()).toHaveLength(1)
  })

  it('contract edges with different contract names coexist', () => {
    const store = seededStore()
    store.mergeAutoEdges([
      { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'api', name: 'GET /x' } },
      { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'event', name: 'fired' } },
    ])
    expect(store.listEdges()).toHaveLength(2)
  })

  it('manual edges are never overwritten by auto merges', () => {
    const store = seededStore()
    const manual = store.addManualEdge({
      from: 'a',
      to: 'b',
      type: 'contract',
      contractRef: { kind: 'api', name: 'GET /x' },
    })
    expect(manual.source).toBe('manual')
    expect(manual.status).toBe('confirmed')
    expect(manual.strength).toBe(1)

    const report = store.mergeAutoEdges([
      { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'api', name: 'GET /x' }, strength: 0.3 },
    ])
    expect(report.skippedManual).toBe(1)
    expect(report.updated).toHaveLength(0)
    const edge = store.getEdge(manual.id)!
    expect(edge.source).toBe('manual')
    expect(edge.strength).toBe(1)
  })

  it('suppressed edges are never resurrected by auto merges', () => {
    const store = seededStore()
    store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build' }])
    const edge = store.listEdges()[0]!
    store.suppressEdge(edge.id, 'moved to HTTP')
    expect(edge.status).toBe('candidate')

    const report = store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build', strength: 1 }])
    expect(report.skippedSuppressed).toBe(1)
    expect(store.listEdges()[0]!.status).toBe('suppressed')
    expect(store.listSuppressed()).toEqual([
      { from: 'a', to: 'b', type: 'build', reason: 'moved to HTTP' },
    ])
  })

  it('relation-level suppression blocks suggestions even before an edge exists', () => {
    const store = seededStore()
    store.suppressRelation('a', 'b', 'contract', 'contract moved elsewhere')
    const report = store.mergeAutoEdges([
      { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'event', name: 'x' } },
    ])
    expect(report.skippedSuppressed).toBe(1)
    expect(report.added).toHaveLength(0)
  })

  it('manual confirmation replaces a suppressed edge and clears the mark', () => {
    const store = seededStore()
    store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build' }])
    const id = store.listEdges()[0]!.id
    store.suppressEdge(id)
    const redrawn = store.addManualEdge({ from: 'a', to: 'b', type: 'build' })
    expect(redrawn.id).toBe(id)
    expect(redrawn.source).toBe('manual')
    expect(redrawn.status).toBe('confirmed')
    expect(store.listSuppressed()).toEqual([])
    const report = store.mergeAutoEdges([{ from: 'a', to: 'b', type: 'build' }])
    expect(report.skippedManual).toBe(1)
  })

  it('rejects edges that name unknown repos', () => {
    const store = seededStore()
    expect(() => store.addManualEdge({ from: 'x', to: 'b', type: 'build' })).toThrow(TypeError)
    expect(() => store.mergeAutoEdges([{ from: 'a', to: 'x', type: 'build' }])).toThrow(TypeError)
  })

  it('rejects an unknown contractRef.kind at write time, not at load time', () => {
    const store = seededStore()
    // Before the fix this persisted fine and then bricked the graph at the
    // next open() (validateEdge rejects the kind on load).
    expect(() => store.addManualEdge({
      from: 'a', to: 'b', type: 'contract',
      contractRef: { kind: 'bogus' as 'event', name: 'x' },
    })).toThrow(/unknown contractRef\.kind/)
    // Nothing was written: the store still serializes and reloads cleanly.
    expect(() => store.toDocument()).not.toThrow()
  })

  it('deterministic edge ids survive reloads', () => {
    const doc = acmeGraph()
    const expected = edgeId('notify-service', 'order-service', 'contract', 'order.cancelled')
    expect(doc.edges.some(e => e.id === expected)).toBe(true)
  })
})

describe('validateRepoGraphDocument', () => {
  it('accepts a well-formed document', () => {
    expect(() => validateRepoGraphDocument(acmeGraph())).not.toThrow()
  })

  it('rejects unsupported versions and malformed shapes', () => {
    expect(() => validateRepoGraphDocument({ version: 2 })).toThrow(TypeError)
    expect(() => validateRepoGraphDocument('nope')).toThrow(TypeError)
    expect(() => validateRepoGraphDocument({ version: 1 })).toThrow(TypeError)
  })

  it('rejects edges with unknown endpoints', () => {
    const doc = acmeGraph()
    const mutated = { ...doc, edges: [...doc.edges, { ...doc.edges[0]!, from: 'ghost' }] } as RepoGraphDocument
    expect(() => validateRepoGraphDocument(mutated)).toThrow(TypeError)
  })

  it('rejects inconsistent edge ids', () => {
    const doc = acmeGraph()
    const mutated = {
      ...doc,
      edges: doc.edges.map((edge, i) => (i === 0 ? { ...edge, id: 'e_wrong' } : edge)),
    } as RepoGraphDocument
    expect(() => validateRepoGraphDocument(mutated)).toThrow(TypeError)
  })

  it('rejects out-of-range strength', () => {
    const doc = acmeGraph()
    const mutated = {
      ...doc,
      edges: doc.edges.map((edge, i) => (i === 0 ? { ...edge, strength: 1.5 } : edge)),
    } as RepoGraphDocument
    expect(() => validateRepoGraphDocument(mutated)).toThrow(TypeError)
  })
})
