// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BoardPanel } from '../src/client/Board.tsx'
import type { RepoGraphDocument } from '../src/graph/types.ts'

const graph: RepoGraphDocument = {
  version: 1,
  project: 'demo',
  updatedAt: '2025-01-01T00:00:00.000Z',
  nodes: {
    'web-portal': { name: 'web-portal', path: '/repos/web-portal', labels: [] },
    'shared-sdk': { name: 'shared-sdk', path: '/repos/shared-sdk', labels: [] },
  },
  edges: [
    {
      id: 'web-portal->shared-sdk::contract::order.cancelled',
      from: 'web-portal',
      to: 'shared-sdk',
      type: 'contract',
      strength: 0.9,
      status: 'candidate',
      source: 'auto',
      contractRef: { kind: 'other', name: 'order.cancelled' },
    },
  ],
  suppressed: [],
}

interface FetchCall { url: string; init?: RequestInit }

let calls: FetchCall[]
let posts: unknown[]
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  calls = []
  posts = []
  fetchImpl = (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
    const body = url.endsWith('/graph.json')
      ? graph
      : url.endsWith('/requirements.json')
        ? [{ id: 'req-1', status: 'spec-ready', text: '取消订单时通知用户' }]
        : { error: 'not found' }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  vi.stubGlobal('fetch', fetchImpl)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BoardPanel', () => {
  it('loads the graph and requirement strip and renders nodes with contract labels', async () => {
    const { container } = render(<BoardPanel />)
    await waitFor(() => { expect(screen.getByText('web-portal')).toBeTruthy() })
    expect(screen.getByText('shared-sdk')).toBeTruthy()
    expect(container.querySelector('[data-node-id="web-portal"]')).toBeTruthy()
    expect(container.querySelector('[data-edge-id="web-portal->shared-sdk::contract::order.cancelled"]')).toBeTruthy()
    expect(screen.getByText('demo · 2 仓 · 1 边')).toBeTruthy()
    expect(screen.getByText('req-1')).toBeTruthy()
    expect(screen.getByText('取消订单时通知用户')).toBeTruthy()
  })

  it('draws a manual edge end to end: pick start, pick target, choose type, confirm', async () => {
    const { container } = render(<BoardPanel />)
    await waitFor(() => { expect(screen.getByText('web-portal')).toBeTruthy() })

    fireEvent.click(screen.getByText('手动连边'))
    fireEvent.click(container.querySelector('[data-node-id="shared-sdk"]')!)
    fireEvent.click(container.querySelector('[data-node-id="web-portal"]')!)

    const select = screen.getByDisplayValue('semantic') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'contract' } })
    fireEvent.change(screen.getByPlaceholderText(/契约名/), { target: { value: 'order.cancelled' } })

    fireEvent.click(screen.getByText('添加边（起点 → 目标）'))

    await waitFor(() => { expect(posts.length).toBeGreaterThanOrEqual(1) })
    expect(posts[0]).toEqual({
      action: 'add-manual-edge',
      from: 'shared-sdk',
      to: 'web-portal',
      type: 'contract',
      contractKind: 'other',
      contractName: 'order.cancelled',
    })
  })

  it('confirms and suppresses a selected edge through the detail panel', async () => {
    const { container } = render(<BoardPanel />)
    await waitFor(() => { expect(screen.getByText('web-portal')).toBeTruthy() })

    fireEvent.click(container.querySelector('[data-edge-id="web-portal->shared-sdk::contract::order.cancelled"]')!)
    await waitFor(() => { expect(screen.getByText('确认')).toBeTruthy() })
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => { expect(posts.at(-1)).toMatchObject({ action: 'confirm', id: 'web-portal->shared-sdk::contract::order.cancelled' }) })

    fireEvent.click(container.querySelector('[data-edge-id="web-portal->shared-sdk::contract::order.cancelled"]')!)
    await waitFor(() => { expect(screen.getByText('抑制')).toBeTruthy() })
    fireEvent.click(screen.getByText('抑制'))
    await waitFor(() => { expect(posts.at(-1)).toMatchObject({ action: 'suppress', id: 'web-portal->shared-sdk::contract::order.cancelled' }) })
  })

  it('surfaces fetch failures as an error banner and offers retry', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url.endsWith('/graph.json')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(new Response('[]', { status: 200 })))
    render(<BoardPanel />)
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
    expect(screen.getByText('刷新')).toBeTruthy()
  })
})
