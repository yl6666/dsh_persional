import { describe, expect, it } from 'vitest'
import { defaultMetrics, edgeAt, edgeColor, edgePath, layoutBoard, nodeAccent, nodeAt } from '../src/client/viewmodel.ts'
import type { RepoGraphDocument, RepoEdge, RepoEdgeType } from '../src/graph/types.ts'

/** Loose edge input for fixtures; every field has a sensible default. */
interface EdgeInput {
  id?: string
  from: string
  to: string
  type?: RepoEdgeType
  status?: RepoEdge['status']
  source?: RepoEdge['source']
  contractRef?: RepoEdge['contractRef']
}

function documentOf(edges: readonly EdgeInput[]): RepoGraphDocument {
  const names = new Set<string>()
  for (const edge of edges) {
    names.add(edge.from)
    names.add(edge.to)
  }
  return {
    version: 1,
    project: 'demo',
    updatedAt: '2025-01-01T00:00:00.000Z',
    nodes: Object.fromEntries([...names].map(name => [name, { name, path: '/repos/' + name, labels: [] }])),
    edges: edges.map(edge => ({
      id: edge.id ?? edge.from + '->' + edge.to + '::' + (edge.type ?? 'semantic') + (edge.contractRef?.name !== undefined ? '::' + edge.contractRef?.name : ''),
      from: edge.from,
      to: edge.to,
      type: edge.type ?? 'semantic',
      strength: 0.8,
      status: edge.status ?? 'candidate',
      source: edge.source ?? 'auto',
      contractRef: edge.contractRef,
    })),
    suppressed: [],
  }
}

describe('layoutBoard', () => {
  it('layers upstream repos left: depth follows dependency direction', () => {
    const layout = layoutBoard(documentOf([
      { from: 'web-portal', to: 'order-service', type: 'build' },
      { from: 'order-service', to: 'shared-sdk', type: 'build' },
    ]))
    const depth = (repo: string) => layout.nodes.find(node => node.repo === repo)?.depth
    expect(depth('web-portal')).toBe(0)
    expect(depth('order-service')).toBe(1)
    expect(depth('shared-sdk')).toBe(2)
    const column = (repo: string) => layout.nodes.find(node => node.repo === repo)?.x
    expect(column('web-portal')).toBeLessThan(column('order-service')!)
    expect(column('order-service')).toBeLessThan(column('shared-sdk')!)
    expect(layout.width).toBe(defaultMetrics.padding * 2 + 3 * defaultMetrics.nodeWidth + 2 * defaultMetrics.layerGap)
    expect(layout.height).toBeGreaterThanOrEqual(defaultMetrics.padding * 2 + defaultMetrics.nodeHeight)
  })

  it('groups mutual contract edges into one cycle unit sharing a column', () => {
    const layout = layoutBoard(documentOf([
      { from: 'a', to: 'b', type: 'contract', contractRef: { kind: 'other', name: 'ping' } },
      { from: 'b', to: 'a', type: 'contract', contractRef: { kind: 'other', name: 'pong' } },
      { from: 'c', to: 'a', type: 'build' },
    ]))
    const a = layout.nodes.find(node => node.repo === 'a')
    const b = layout.nodes.find(node => node.repo === 'b')
    expect(a?.cyclePeers).toEqual(['b'])
    expect(b?.cyclePeers).toEqual(['a'])
    // Both members share the cycle unit's effective depth (the max of the
    // saturated pair), and sit strictly right of the acyclic predecessor.
    expect(a?.depth).toBe(b?.depth)
    expect(a?.depth).toBeGreaterThan(layout.nodes.find(node => node.repo === 'c')?.depth ?? -1)
    expect(layout.nodes.find(node => node.repo === 'c')?.depth).toBe(0)
  })

  it('excludes suppressed edges from layering', () => {
    const layout = layoutBoard(documentOf([
      { from: 'a', to: 'b', type: 'build', status: 'suppressed' },
    ]))
    expect(layout.nodes.find(node => node.repo === 'b')?.depth).toBe(0)
    expect(layout.edges.every(edge => edge.status === 'suppressed' || edge.status !== undefined)).toBe(true)
  })

  it('computes bezier geometry between node centers with a midpoint', () => {
    const layout = layoutBoard(documentOf([
      { from: 'web', to: 'sdk', type: 'contract', contractRef: { kind: 'other', name: 'order.cancelled' } },
    ]))
    const edge = layout.edges[0]!
    expect(edge.mx).toBe((edge.x1 + edge.x2) / 2)
    expect(edge.my).toBe((edge.y1 + edge.y2) / 2)
    expect(edge.dx).toBeGreaterThan(0)
    expect(edge.contract).toBe('order.cancelled')
    expect(edgePath(edge)).toContain('C ')
  })

  it('stacks same-column repos in sorted rows without overlap', () => {
    const layout = layoutBoard(documentOf([
      { from: 'app1', to: 'sdk', type: 'build' },
      { from: 'app2', to: 'sdk', type: 'build' },
      { from: 'app3', to: 'sdk', type: 'build' },
    ]))
    const rows = layout.nodes.filter(node => node.depth === 0).map(node => node.y).sort((a, b) => a - b)
    expect(rows.length).toBe(3)
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index]! - rows[index - 1]!).toBeGreaterThanOrEqual(defaultMetrics.nodeHeight + defaultMetrics.rowGap)
    }
    expect(layout.nodes.filter(node => node.depth === 0).map(node => node.repo)).toEqual(['app1', 'app2', 'app3'])
  })
})

describe('hit testing and colors', () => {
  const layout = layoutBoard(documentOf([
    { from: 'web', to: 'sdk', type: 'contract' },
  ]))
  const edge = layout.edges[0]!

  it('nodeAt maps canvas coordinates to nodes', () => {
    expect(nodeAt(layout, 40, 40)?.repo).toBe('web')
    expect(nodeAt(layout, 40 + defaultMetrics.nodeWidth - 1, 40 + 10)?.repo).toBe('web')
    expect(nodeAt(layout, 5000, 5000)).toBeUndefined()
  })

  it('edgeAt hits the midpoint hitbox', () => {
    expect(edgeAt(layout, edge.mx, edge.my)?.id).toBe(edge.id)
    expect(edgeAt(layout, edge.mx + 17, edge.my)?.id).toBe(edge.id)
    expect(edgeAt(layout, edge.mx + 30, edge.my)).toBeUndefined()
  })

  it('edgeColor distinguishes layers and suppressed edges', () => {
    expect(edgeColor('contract', 'confirmed')).toBe('#d97706')
    expect(edgeColor('build', 'confirmed')).toBe('#2563eb')
    expect(edgeColor('code', 'confirmed')).toBe('#7c3aed')
    expect(edgeColor('semantic', 'confirmed')).toBe('#6b7280')
    expect(edgeColor('build', 'suppressed')).toBe('#9ca3af')
  })

  it('nodeAccent flags cycle members', () => {
    expect(nodeAccent({ repo: 'x', x: 0, y: 0, depth: 0, cyclePeers: [] })).toBe('#0f766e')
    expect(nodeAccent({ repo: 'x', x: 0, y: 0, depth: 0, cyclePeers: ['y'] })).toBe('#dc2626')
  })
})
