import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as webserverPlugin from '../src/webserver.ts'
import type { WebRoute } from '../src/webserver.ts'
import { RepoBoardService } from '../src/service.ts'
import type { RepoGraphDocument } from '../src/graph/types.ts'

const tmpDir = join('test', '.tmp-web')
const graphPath = join(tmpDir, 'demo.graph.json')

interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

class FakeWebServer {
  readonly routes = new Map<string, { route: WebRoute; captured: CapturedResponse[] }>()

  register(route: WebRoute): () => void {
    this.routes.set(route.path, { route, captured: [] })
    return () => { this.routes.delete(route.path) }
  }
}

function fakeRequest(method: 'GET' | 'POST', body?: string) {
  return {
    method,
    on(event: string, listener: (arg?: unknown) => void) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(body))
      if (event === 'end') listener()
      return this
    },
  }
}

async function call(
  server: FakeWebServer,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
): Promise<CapturedResponse> {
  const entry = server.routes.get(path)
  if (entry === undefined) throw new Error('route not registered: ' + path)
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      captured.headers = headers ?? {}
      return this
    },
    end(chunk?: string) {
      captured.body += chunk ?? ''
    },
  }
  await entry.route.handler(fakeRequest(method, body) as never, response as never)
  return captured
}

let ctx: Context
let board: RepoBoardService
let server: FakeWebServer

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  ctx = new Context()
  await ctx.plugin(RepoBoardService)
  board = (ctx as unknown as { repoBoard: RepoBoardService }).repoBoard
  server = new FakeWebServer()
  ;(ctx as unknown as { webServer: FakeWebServer }).webServer = server
  webserverPlugin.apply(ctx)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('repo-board-web routes', () => {
  it('registers the three routes', () => {
    expect([...server.routes.keys()].sort()).toEqual([
      '/repo-board/edges',
      '/repo-board/graph.json',
      '/repo-board/requirements.json',
    ])
  })

  it('serves 404 before any graph is open, 200 after scanning', async () => {
    const before = await call(server, '/repo-board/graph.json', 'GET')
    expect(before.status).toBe(404)

    await board.open('demo', graphPath)
    await board.upsertNode('web-portal', { name: 'web-portal', path: 'test/demo-repos/web-portal', labels: [] })
    await board.upsertNode('shared-sdk', { name: 'shared-sdk', path: 'test/demo-repos/shared-sdk', labels: [] })
    await board.addManualEdge({ from: 'web-portal', to: 'shared-sdk', type: 'build' })

    const after = await call(server, '/repo-board/graph.json', 'GET')
    expect(after.status).toBe(200)
    expect(after.headers['content-type']).toContain('application/json')
    const document = JSON.parse(after.body) as RepoGraphDocument
    expect(document.project).toBe('demo')
    expect(Object.keys(document.nodes)).toContain('web-portal')
    expect(document.edges.length).toBe(1)
  })

  it('lists requirements from the registry', async () => {
    await board.open('demo', graphPath)
    const created = await board.createRequirement({ text: '取消订单时通知用户' })
    const response = await call(server, '/repo-board/requirements.json', 'GET')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual([
      { id: created.id, status: 'draft', text: '取消订单时通知用户' },
    ])
  })

  it('applies every edge mutation verb and returns the updated graph', async () => {
    await board.open('demo', graphPath)
    await board.upsertNode('a', { name: 'a', path: '/a', labels: [] })
    await board.upsertNode('b', { name: 'b', path: '/b', labels: [] })

    const added = await call(server, '/repo-board/edges', 'POST', JSON.stringify({
      action: 'add-manual-edge', from: 'a', to: 'b', type: 'contract', contractName: 'order.cancelled', contractKind: 'other',
    }))
    expect(added.status).toBe(200)
    const edgeId = (JSON.parse(added.body) as RepoGraphDocument).edges[0]!.id
    expect(edgeId).toBe('a->b::contract::order.cancelled')

    const suppressed = await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'suppress', id: edgeId }))
    expect((JSON.parse(suppressed.body) as RepoGraphDocument).edges[0]!.status).toBe('suppressed')

    const confirmed = await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'confirm', id: edgeId }))
    expect((JSON.parse(confirmed.body) as RepoGraphDocument).edges[0]!.status).toBe('confirmed')

    const removed = await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'remove', id: edgeId }))
    expect((JSON.parse(removed.body) as RepoGraphDocument).edges.length).toBe(0)
  })

  it('rejects malformed requests with 400/405/409/422', async () => {
    expect((await call(server, '/repo-board/edges', 'POST', 'not json')).status).toBe(400)
    expect((await call(server, '/repo-board/edges', 'POST', '{}')).status).toBe(400)
    expect((await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'nope' }))).status).toBe(400)
    expect((await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'confirm' }))).status).toBe(400)
    expect((await call(server, '/repo-board/edges', 'GET')).status).toBe(405)
    // No graph open yet: a well-formed request is refused with 409.
    expect((await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'confirm', id: 'x' }))).status).toBe(409)

    await board.open('demo', graphPath)
    const badType = await call(server, '/repo-board/edges', 'POST', JSON.stringify({
      action: 'add-manual-edge', from: 'a', to: 'b', type: 'nope',
    }))
    expect(badType.status).toBe(422)
    expect(JSON.parse(badType.body)).toEqual({ error: expect.stringContaining('type') })
    const missingEdge = await call(server, '/repo-board/edges', 'POST', JSON.stringify({ action: 'confirm', id: 'missing' }))
    expect(missingEdge.status).toBe(422)
  })
})
