import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RepoBoardService } from '../src/service.ts'
import type { RepoGraphDocument } from '../src/graph/types.ts'
import { edgeId } from '../src/graph/types.ts'
import { RequirementRecord } from '../src/pipeline/flow.ts'
import type { RepoGitGateway } from '../src/exec/executor.ts'
import type { RepoTaskOutcome } from '../src/exec/executor.ts'

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

/** Build a planned requirement record over the scanned demo graph. */
async function plannedRequirement(service: RepoBoardService, repos: string[]): Promise<RequirementRecord> {
  const { record } = await service.createRequirement({ text: '订单超时自动取消' })
  const graph = service.document
  return record
    .attachSpec({
      text: '订单超时自动取消；order.cancelled 新增 reason 字段',
      goals: ['超时取消', '通知携带原因'],
      candidateRepos: repos,
      constraints: [],
      acceptance: ['超时订单自动取消'],
    })
    .analyze(graph)
    .attachPlans(
      repos.map(repo => ({
        repo,
        summary: '改动 ' + repo,
        changes: [],
        writeScopes: [],
        contractImpact: { breaking: [], downstream: [] },
        prerequisites: [],
        acceptance: [],
      })),
    )
}

function fakeGitGateway(changes: string[]): RepoGitGateway & { commits: { cwd: string; message: string }[] } {
  const gateway = {
    commits: [] as { cwd: string; message: string }[],
    async checkoutBranch() {},
    async listChangedFiles() {
      return [...changes]
    },
    async commitAll(cwd: string, message: string) {
      gateway.commits.push({ cwd, message })
      return 'commit-hash-1'
    },
  }
  return gateway
}

const okTask = async (): Promise<RepoTaskOutcome> => ({ state: 'succeeded', commit: 'session-commit' })

describe('dispatch mutex and the human submit gate (e2e design 6.1, 16.1)', () => {
  it('refuses a second dispatch touching any repo with a run in flight, releases after', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)
    const first = await plannedRequirement(service, ['order-service'])
    const second = await plannedRequirement(service, ['order-service', 'notify-service'])

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const inFlight = service.dispatchRequirement(first, async () => {
      await gate
      return { state: 'succeeded' }
    })
    // Overlapping repo -> rejected while the first run is in flight.
    await expect(service.dispatchRequirement(second, okTask)).rejects.toThrow(/running dispatch: order-service/)
    // A disjoint requirement may proceed (shared repos only).
    const third = await plannedRequirement(service, ['web-portal'])
    await expect(service.dispatchRequirement(third, okTask)).resolves.toBeDefined()

    release()
    await inFlight
    // Mutex released: the same repos are dispatchable again.
    await expect(service.dispatchRequirement(second, okTask)).resolves.toBeDefined()
  })

  it('manual policy parks repos at submit-pending; approve commits host-side, reject parks for humans', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)
    const record = await plannedRequirement(service, ['order-service'])
    const git = fakeGitGateway(['src/order.ts'])

    const { record: dispatched } = await service.dispatchRequirement(record, okTask, {
      git, commitPolicy: 'manual',
    })
    const run = dispatched.toDocument().run!
    expect(run.perRepo[0]!.state).toBe('submit-pending')
    expect(run.perRepo[0]!.submitRequest?.changedFiles).toEqual(['src/order.ts'])

    // Reject records the decision without committing.
    const rejected = await service.rejectSubmit(dispatched, 'order-service', '方案不对')
    let entry = rejected.toDocument().run!.perRepo[0]!
    expect(entry.state).toBe('needs-human')
    expect(git.commits).toEqual([])
    expect(rejected.toDocument().run!.errors).toContain('submit rejected for order-service: 方案不对')

    // Approve only works from submit-pending - the rejected record refuses.
    await expect(service.approveSubmit(rejected, 'order-service')).rejects.toThrow(/not waiting for a submit decision/)

    // A fresh dispatch returns to submit-pending and approves cleanly.
    const again = await plannedRequirement(service, ['order-service'])
    const { record: pending } = await service.dispatchRequirement(again, okTask, {
      git, commitPolicy: 'manual',
    })
    const submitted = await service.approveSubmit(pending, 'order-service')
    entry = submitted.toDocument().run!.perRepo[0]!
    expect(entry.state).toBe('submitted')
    expect(entry.commit).toBe('commit-hash-1')
    expect(git.commits).toEqual([
      { cwd: join('test', 'demo-repos', 'order-service'), message: 'ai(order-service): 改动 order-service' },
    ])
    // The waiting-for-approval notice is cleaned out of the run errors.
    expect(submitted.toDocument().run!.errors).toEqual([])
  })

  it('submit decisions validate their preconditions loudly', async () => {
    const service = makeService()
    await service.open('acme-demo', graphPath)
    await service.scan(repos)
    const record = await plannedRequirement(service, ['order-service'])

    // No run attached yet.
    await expect(service.approveSubmit(record, 'order-service')).rejects.toThrow(/dispatched requirement/)
    // Manual dispatch without a git gateway: submit-pending is unreachable,
    // so approve has nothing to approve and says so.
    const { record: dispatched } = await service.dispatchRequirement(record, okTask, { commitPolicy: 'manual' })
    expect(dispatched.toDocument().run!.perRepo[0]!.state).toBe('succeeded')
    await expect(service.approveSubmit(dispatched, 'order-service')).rejects.toThrow(/not waiting/)
    await expect(service.approveSubmit(dispatched, 'no-such-repo')).rejects.toThrow(/no run entry/)
  })
})
