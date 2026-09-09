import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RepoBoardService } from '../src/service.ts'
import type { RepoGraphDocument } from '../src/graph/types.ts'
import { edgeId } from '../src/graph/types.ts'

const graphPath = join('test', '.tmp', 'demo-graph.json')
const repos = [
  { key: 'shared-sdk', path: join('test', 'demo-repos', 'shared-sdk') },
  { key: 'order-service', path: join('test', 'demo-repos', 'order-service') },
  { key: 'notify-service', path: join('test', 'demo-repos', 'notify-service') },
  { key: 'web-portal', path: join('test', 'demo-repos', 'web-portal') },
]

function makeService(): RepoBoardService {
  return new RepoBoardService(new Context())
}

afterAll(async () => {
  await rm(join('test', '.tmp'), { recursive: true, force: true })
})

function edgeTuples(doc: RepoGraphDocument): string[][] {
  return doc.edges.map(edge => [edge.from, edge.to, edge.type, edge.contractRef?.name ?? ''])
}

describe('RepoBoardService scan pipeline (M0/M1/M2 integration)', () => {
  it('scans the demo repo group into a full graph', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    const doc = await service.scan(repos)

    expect(doc.project).toBe('acme-demo')
    expect(doc.version).toBe(1)
    expect(Object.keys(doc.nodes).sort()).toEqual([
      'notify-service',
      'order-service',
      'shared-sdk',
      'web-portal',
    ])
    expect(doc.nodes['order-service']!.name).toBe('@acme/order-service')
    expect(doc.nodes['order-service']!.meta).toEqual({ build: ['npm'] })
    expect(doc.nodes['shared-sdk']!.fingerprint).toMatch(/^fnv1a64:/)

    expect(edgeTuples(doc).sort()).toEqual([
      ['notify-service', 'order-service', 'contract', 'order.cancelled'],
      ['notify-service', 'shared-sdk', 'build', ''],
      ['order-service', 'shared-sdk', 'build', ''],
      ['web-portal', 'order-service', 'build', ''],
      ['web-portal', 'order-service', 'contract', '/orders'],
      ['web-portal', 'order-service', 'contract', 'listOrders'],
      ['web-portal', 'shared-sdk', 'build', ''],
    ])

    const orderToSdk = doc.edges.find(e => e.from === 'order-service' && e.to === 'shared-sdk')!
    expect(orderToSdk.versionConstraint).toBe('^1.2.0')
    expect(orderToSdk.source).toBe('auto')
    expect(orderToSdk.status).toBe('candidate')
  })

  it('impact: blast radius of order-service and shared-sdk', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)
    expect(service.impact('order-service')).toEqual(['notify-service', 'web-portal'])
    expect(service.impact('shared-sdk')).toEqual(['notify-service', 'order-service', 'web-portal'])
    expect(service.dependencies('web-portal')).toEqual(['order-service', 'shared-sdk'])
  })

  it('topology: upstream first with depths', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)
    expect(service.topologicalUnits().map(u => [u.repos, u.depth])).toEqual([
      [['shared-sdk'], 0],
      [['order-service'], 1],
      [['notify-service'], 2],
      [['web-portal'], 2],
    ])
  })

  it('persists the graph and reopens it faithfully', async () => {
    const first = makeService()
    const doc = await first.open('acme-demo', graphPath).then(() => first.scan(repos))

    const second = makeService()
    const reopened = await second.open('acme-demo', graphPath)
    expect(reopened.nodes).toEqual(doc.nodes)
    expect(reopened.edges).toEqual(doc.edges)
    expect(second.impact('order-service')).toEqual(['notify-service', 'web-portal'])
  })

  it('manual suppression shrinks the blast radius and survives reopen', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)

    const id = edgeId('notify-service', 'order-service', 'contract', 'order.cancelled')
    await service.suppressEdge(id, 'notify migrated to polling')
    expect(service.impact('order-service')).toEqual(['web-portal'])

    const reopened = makeService()
    await reopened.open('acme-demo', graphPath)
    expect(reopened.impact('order-service')).toEqual(['web-portal'])
    expect(reopened.document.suppressed).toEqual([
      { from: 'notify-service', to: 'order-service', type: 'contract', reason: 'notify migrated to polling' },
    ])
  })

  it('manual edges beat auto merges across rescans', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.addManualEdge({ from: 'shared-sdk', to: 'order-service', type: 'semantic' })
    await service.scan(repos)
    const doc = service.document
    const manual = doc.edges.find(
      e => e.from === 'shared-sdk' && e.to === 'order-service' && e.type === 'semantic',
    )
    expect(manual?.source).toBe('manual')
    expect(manual?.status).toBe('confirmed')
    expect(service.impact('order-service')).toEqual(['notify-service', 'shared-sdk', 'web-portal'])
  })

  it('rejects queries before a graph is open and on malformed graph files', async () => {
    const service = makeService()
    expect(() => service.document).toThrow(/no graph is open/)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join('test', '.tmp', 'broken.json'), '{ not json', 'utf8')
    await expect(service.open('broken', join('test', '.tmp', 'broken.json'))).rejects.toThrow()
  })
})
