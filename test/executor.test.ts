import { describe, expect, it } from 'vitest'
import { executePlans } from '../src/exec/executor.ts'
import type { RepoTaskOutcome } from '../src/exec/executor.ts'
import type { RepoModificationPlan } from '../src/pipeline/types.ts'
import { RequirementRecord } from '../src/pipeline/flow.ts'

function plan(repo: string, prerequisites: string[] = []): RepoModificationPlan {
  return {
    repo,
    summary: 's',
    changes: [],
    writeScopes: [],
    contractImpact: { breaking: [], downstream: [] },
    prerequisites,
    acceptance: [],
  }
}

describe('executePlans scheduling', () => {
  it('runs upstream first, siblings in parallel', async () => {
    const order: string[] = []
    const run = await executePlans([plan('a'), plan('b', ['a']), plan('c', ['a'])], async ({ plan }) => {
      order.push('start:' + plan.repo)
      await new Promise(resolve => setTimeout(resolve, plan.repo === 'a' ? 20 : 5))
      order.push('end:' + plan.repo)
      return { state: 'succeeded' }
    })
    expect(run.errors).toEqual([])
    expect(run.perRepo.map(r => [r.repo, r.state])).toEqual([
      ['a', 'succeeded'],
      ['b', 'succeeded'],
      ['c', 'succeeded'],
    ])
    expect(order.indexOf('start:a')).toBeLessThan(order.indexOf('start:b'))
    expect(order.indexOf('start:a')).toBeLessThan(order.indexOf('start:c'))
  })

  it('a failure blocks transitive dependents and lands in errors', async () => {
    const run = await executePlans(
      [plan('a'), plan('b', ['a']), plan('c', ['b']), plan('d')],
      async ({ plan }) =>
        plan.repo === 'a'
          ? { state: 'failed', error: 'tests red' }
          : { state: 'succeeded' },
    )
    expect(run.perRepo.map(r => [r.repo, r.state])).toEqual([
      ['a', 'failed'],
      ['b', 'needs-human'],
      ['c', 'needs-human'],
      ['d', 'succeeded'],
    ])
    expect(run.errors).toEqual([
      'a: tests red',
      'b: blocked by upstream a',
      'c: blocked by upstream a',
    ])
  })

  it('a needs-human outcome blocks dependents the same way', async () => {
    const run = await executePlans(
      [plan('a'), plan('b', ['a'])],
      async ({ plan }) =>
        plan.repo === 'a' ? { state: 'needs-human', reason: 'ambiguous spec' } : { state: 'succeeded' },
    )
    expect(run.perRepo.map(r => [r.repo, r.state])).toEqual([
      ['a', 'needs-human'],
      ['b', 'needs-human'],
    ])
    expect(run.errors).toContain('a: ambiguous spec')
  })

  it('prerequisite cycles surface for human review and never run', async () => {
    let ran = 0
    const run = await executePlans([plan('a', ['b']), plan('b', ['a']), plan('c')], async () => {
      ran += 1
      return { state: 'succeeded' }
    })
    expect(ran).toBe(1)
    expect(run.perRepo.map(r => [r.repo, r.state])).toEqual([
      ['a', 'needs-human'],
      ['b', 'needs-human'],
      ['c', 'succeeded'],
    ])
    expect(run.errors).toEqual(['prerequisite cycle among: a, b - needs human review'])
  })

  it('honors the concurrency cap', async () => {
    let live = 0
    let peak = 0
    const run = await executePlans(
      [plan('a'), plan('b'), plan('c'), plan('d')],
      async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise(resolve => setTimeout(resolve, 10))
        live -= 1
        return { state: 'succeeded' }
      },
      { concurrency: 2 },
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(run.errors).toEqual([])
  })

  it('task exceptions become failures, not crashes', async () => {
    const run = await executePlans([plan('a')], async () => {
      throw new Error('worker exploded')
    })
    expect(run.perRepo[0]).toMatchObject({ repo: 'a', state: 'failed' })
    expect(run.errors).toEqual(['a: worker exploded'])
  })

  it('records commit, diff summary, and session id per repo', async () => {
    const outcomes: Record<string, RepoTaskOutcome> = {
      a: { state: 'succeeded', commit: 'abc123', diffSummary: '2 files, +10 -3', sessionId: 'sess-1' },
    }
    const run = await executePlans([plan('a')], async ({ plan }) => outcomes[plan.repo] ?? { state: 'succeeded' })
    expect(run.perRepo[0]).toEqual({
      repo: 'a',
      state: 'succeeded',
      commit: 'abc123',
      diffSummary: '2 files, +10 -3',
      sessionId: 'sess-1',
    })
  })

  it('passes repo paths from options into task contexts', async () => {
    const seen: (string | undefined)[] = []
    await executePlans([plan('a'), plan('b')], async ({ plan, repoPath }) => {
      seen.push(repoPath)
      return { state: 'succeeded' }
    }, { repoPaths: { a: 'D:/checkouts/a' } })
    expect(seen.sort()).toEqual(['D:/checkouts/a', undefined])
  })
})

describe('dispatch with run', () => {
  it('attaches the execution run to the dispatched record', async () => {
    const record = RequirementRecord.create('req-1', { text: 't' })
    expect(() => record.dispatch()).toThrow(/planned/)
    const spec = {
      text: 't',
      goals: [],
      candidateRepos: ['order-service'],
      constraints: [],
      acceptance: [],
    }
    const graph = {
      version: 1 as const,
      project: 'p',
      updatedAt: '2026-01-01T00:00:00.000Z',
      nodes: { 'order-service': { name: 'order-service', labels: [] } },
      edges: [],
      suppressed: [],
    }
    const planned = record.attachSpec(spec).analyze(graph).attachPlans([plan('order-service')])
    const run = { perRepo: [{ repo: 'order-service', state: 'succeeded' as const }], errors: [] }
    const dispatched = planned.dispatch(run)
    expect(dispatched.status).toBe('dispatched')
    expect(dispatched.toDocument().run).toEqual(run)
  })
})
