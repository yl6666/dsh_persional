import { describe, expect, it } from 'vitest'
import {
  dependencies,
  impact,
  impactReport,
  topologicalUnits,
  writeScopeConflicts,
} from '../src/graph/algorithms.ts'
import { RepoGraphStore } from '../src/graph/store.ts'
import { acmeGraph, buildOnlyCycleGraph, cycleGraph, selfLoopGraph, UPDATED_AT } from './fixtures.ts'

describe('dependencies / impact (13.2-1)', () => {
  it('dependencies returns the forward reachable set', () => {
    expect(dependencies(acmeGraph(), 'order-service')).toEqual(['shared-sdk'])
    expect(dependencies(acmeGraph(), 'audit-service')).toEqual(['order-service', 'shared-sdk'])
    expect(dependencies(acmeGraph(), 'web-portal')).toEqual(['audit-service', 'order-service', 'shared-sdk'])
  })

  it('impact returns the reverse reachable set - the blast radius', () => {
    expect(impact(acmeGraph(), 'order-service')).toEqual(['audit-service', 'notify-service', 'web-portal'])
    expect(impact(acmeGraph(), 'shared-sdk')).toEqual([
      'audit-service',
      'notify-service',
      'order-service',
      'web-portal',
    ])
  })

  it('impact can be restricted to contract edges', () => {
    expect(impact(acmeGraph(), 'order-service', { edgeTypes: ['contract'] })).toEqual([
      'audit-service',
      'notify-service',
    ])
    expect(impact(acmeGraph(), 'shared-sdk', { edgeTypes: ['contract'] })).toEqual([])
  })

  it('suppressed edges never participate in traversal', () => {
    const store = RepoGraphStore.load(acmeGraph())
    const edge = store.listEdges().find(e => e.from === 'notify-service' && e.type === 'contract')
    expect(edge).toBeDefined()
    store.suppressEdge(edge!.id)
    const doc = store.toDocument(UPDATED_AT)
    expect(impact(doc, 'order-service')).toEqual(['audit-service', 'web-portal'])
    expect(dependencies(doc, 'notify-service')).toEqual(['shared-sdk'])
  })

  it('unknown repos reject loudly', () => {
    expect(() => impact(acmeGraph(), 'nope')).toThrow(TypeError)
    expect(() => dependencies(acmeGraph(), 'nope')).toThrow(TypeError)
  })
})

describe('impactReport (13.2-1)', () => {
  it('splits direct vs transitive dependents and breaks the radius down by edge type', () => {
    const report = impactReport(acmeGraph(), 'shared-sdk')
    expect(report.repo).toBe('shared-sdk')
    expect(report.direct).toEqual(['audit-service', 'notify-service', 'order-service'])
    expect(report.transitive).toEqual(['web-portal'])
    expect(report.byEdgeType.build).toEqual(['audit-service', 'notify-service', 'order-service', 'web-portal'])
    expect(report.byEdgeType.contract).toEqual([])
  })

  it('reports contract-only radii for the emitting repo', () => {
    const report = impactReport(acmeGraph(), 'order-service')
    expect(report.direct).toEqual(['audit-service', 'notify-service'])
    expect(report.transitive).toEqual(['web-portal'])
    expect(report.byEdgeType.contract).toEqual(['audit-service', 'notify-service'])
    expect(report.byEdgeType.build).toEqual([])
  })
})

describe('topologicalUnits (13.2-2, 13.2-3)', () => {
  it('orders upstream first with depths', () => {
    const units = topologicalUnits(acmeGraph())
    expect(units.map(u => [u.repos, u.depth])).toEqual([
      [['shared-sdk'], 0],
      [['order-service'], 1],
      [['audit-service'], 2],
      [['notify-service'], 2],
      [['web-portal'], 3],
    ])
    expect(units.every(u => !u.hasContractCycle)).toBe(true)
  })

  it('constrains the induced subgraph to the requested repos', () => {
    const units = topologicalUnits(acmeGraph(), ['order-service', 'shared-sdk'])
    expect(units.map(u => [u.repos, u.depth])).toEqual([[['shared-sdk'], 0], [['order-service'], 1]])
  })

  it('condenses contract cycles into one atomic review-forced unit', () => {
    const units = topologicalUnits(cycleGraph())
    expect(units).toHaveLength(2)
    expect(units[0]!.repos).toEqual(['a', 'b'])
    expect(units[0]!.depth).toBe(0)
    expect(units[0]!.hasContractCycle).toBe(true)
    expect(units[1]!.repos).toEqual(['c'])
    expect(units[1]!.depth).toBe(1)
    expect(units[1]!.hasContractCycle).toBe(false)
  })

  it('condenses build-only cycles without the contract flag', () => {
    const units = topologicalUnits(buildOnlyCycleGraph())
    expect(units).toHaveLength(1)
    expect(units[0]!.repos).toEqual(['a', 'b'])
    expect(units[0]!.hasContractCycle).toBe(false)
  })

  it('treats self-loops as atomic units', () => {
    const units = topologicalUnits(selfLoopGraph())
    expect(units).toHaveLength(1)
    expect(units[0]!.repos).toEqual(['a'])
    expect(units[0]!.hasContractCycle).toBe(true)
  })

  it('rejects unknown repos', () => {
    expect(() => topologicalUnits(acmeGraph(), ['nope'])).toThrow(TypeError)
  })
})

describe('writeScopeConflicts (13.2-4)', () => {
  it('detects prefix overlaps between parallel tasks', () => {
    const conflicts = writeScopeConflicts([
      { repo: 'a', writeScopes: ['src/core'] },
      { repo: 'b', writeScopes: ['src/core/utils'] },
    ])
    expect(conflicts).toEqual([{ repoA: 'a', repoB: 'b', overlaps: ['src/core <-> src/core/utils'] }])
  })

  it('normalizes separators and trailing slashes', () => {
    const conflicts = writeScopeConflicts([
      { repo: 'a', writeScopes: ['src\\core\\'] },
      { repo: 'b', writeScopes: ['src//core'] },
    ])
    expect(conflicts).toEqual([{ repoA: 'a', repoB: 'b', overlaps: ['src/core <-> src/core'] }])
  })

  it('leaves disjoint scopes alone', () => {
    expect(writeScopeConflicts([
      { repo: 'a', writeScopes: ['src/core'] },
      { repo: 'b', writeScopes: ['docs'] },
    ])).toEqual([])
  })

  it('plain string prefixes without a separator boundary never conflict', () => {
    expect(writeScopeConflicts([
      { repo: 'a', writeScopes: ['srcx'] },
      { repo: 'b', writeScopes: ['src'] },
    ])).toEqual([])
  })
})
