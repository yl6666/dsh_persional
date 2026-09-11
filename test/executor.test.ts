import { describe, expect, it } from 'vitest'
import { executePlans } from '../src/exec/executor.ts'
import type { RepoGitGateway, RepoTaskOutcome } from '../src/exec/executor.ts'
import type { RepoModificationPlan } from '../src/pipeline/types.ts'
import { RequirementRecord } from '../src/pipeline/flow.ts'

function plan(repo: string, prerequisites: string[] = [], extra: Partial<RepoModificationPlan> = {}): RepoModificationPlan {
  return {
    repo,
    summary: 's',
    changes: [],
    writeScopes: [],
    contractImpact: { breaking: [], downstream: [] },
    prerequisites,
    acceptance: [],
    ...extra,
  }
}

/** Recording fake for the git seam: scripted branch switch and pending files. */
function fakeGit(changes: Readonly<Record<string, string[]>> = {}, commitPrefix = 'hash-'): RepoGitGateway & {
  checkouts: string[]
  commits: { cwd: string; message: string }[]
  failCheckout?: Error
} {
  const gateway = {
    checkouts: [] as string[],
    commits: [] as { cwd: string; message: string }[],
    failCheckout: undefined as Error | undefined,
    async checkoutBranch(cwd: string, branch: string) {
      if (gateway.failCheckout !== undefined) throw gateway.failCheckout
      gateway.checkouts.push(cwd + '@' + branch)
    },
    async listChangedFiles(cwd: string) {
      return [...(changes[cwd] ?? [])]
    },
    async commitAll(cwd: string, message: string) {
      gateway.commits.push({ cwd, message })
      return commitPrefix + gateway.commits.length
    },
  }
  return gateway
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

describe('branch discipline and the submit gate', () => {
  it('checks out the requirement branch before the task, per-repo, default naming', async () => {
    const git = fakeGit()
    const contexts: { branch: string; repoPath?: string }[] = []
    const run = await executePlans([plan('a'), plan('b', ['a'])], async context => {
      contexts.push(context)
      return { state: 'succeeded' }
    }, { repoPaths: { a: 'D:/a', b: 'D:/b' }, git })
    expect(run.errors).toEqual([])
    expect(git.checkouts).toEqual(['D:/a@ai-delivery/a', 'D:/b@ai-delivery/b'])
    expect(contexts.map(context => context.branch)).toEqual(['ai-delivery/a', 'ai-delivery/b'])
  })

  it('honors plan.branch and branchBase over the default', async () => {
    const git = fakeGit()
    await executePlans(
      [plan('a', [], { branch: 'feature/custom' }), plan('b')],
      async () => ({ state: 'succeeded' }),
      { repoPaths: { a: 'D:/a', b: 'D:/b' }, git, branchBase: 'req/9' },
    )
    expect(git.checkouts).toEqual(['D:/a@feature/custom', 'D:/b@req/9/b'])
  })

  it('refuses to run a plan naming a protected branch, blocking dependents', async () => {
    const git = fakeGit()
    let taskRuns = 0
    const run = await executePlans(
      [plan('a', [], { branch: 'main' }), plan('b', ['a'])],
      async () => {
        taskRuns += 1
        return { state: 'succeeded' }
      },
      { repoPaths: { a: 'D:/a', b: 'D:/b' }, git },
    )
    expect(taskRuns).toBe(0)
    expect(git.checkouts).toEqual([])
    expect(run.perRepo.map(r => [r.repo, r.state])).toEqual([['a', 'needs-human'], ['b', 'needs-human']])
    expect(run.errors[0]).toContain('protected branch main')
  })

  it('a failed branch checkout parks the repo for humans instead of throwing', async () => {
    const git = fakeGit()
    git.failCheckout = new Error('dirty worktree')
    const run = await executePlans([plan('a')], async () => ({ state: 'succeeded' }), {
      repoPaths: { a: 'D:/a' }, git,
    })
    expect(run.perRepo[0]!.state).toBe('needs-human')
    expect(run.errors[0]).toContain('branch checkout failed')
  })

  it('manual policy stops at a submit request with the changed-file list', async () => {
    const git = fakeGit({ 'D:/a': ['src/x.ts', 'src/y.ts'] })
    const run = await executePlans([plan('a', [], { summary: '支持超时取消' })], async () => ({
      state: 'succeeded', sessionId: 'sess-1',
    }), { repoPaths: { a: 'D:/a' }, git, commitPolicy: 'manual', branchBase: 'ai-delivery/req-1' })
    expect(run.perRepo[0]!.state).toBe('submit-pending')
    expect(run.perRepo[0]!.submitRequest).toEqual({
      branch: 'ai-delivery/req-1/a',
      summary: '支持超时取消',
      changedFiles: ['src/x.ts', 'src/y.ts'],
    })
    expect(git.commits).toEqual([])
    expect(run.errors[0]).toContain('waiting for human submit approval')
    // Submit-pending still unblocks dependents: the work itself is done.
    expect(run.perRepo.length).toBe(1)
  })

  it('manual policy with no pending changes records plain success', async () => {
    const git = fakeGit({ 'D:/a': [] })
    const run = await executePlans([plan('a')], async () => ({ state: 'succeeded' }), {
      repoPaths: { a: 'D:/a' }, git, commitPolicy: 'manual',
    })
    expect(run.perRepo[0]!.state).toBe('succeeded')
    expect(run.perRepo[0]!.submitRequest).toBeUndefined()
  })

  it('auto policy trusts the session commit and never builds a submit request', async () => {
    const git = fakeGit({ 'D:/a': ['src/x.ts'] })
    const run = await executePlans([plan('a')], async () => ({
      state: 'succeeded', commit: 'sessionhash',
    }), { repoPaths: { a: 'D:/a' }, git, commitPolicy: 'auto' })
    expect(run.perRepo[0]).toMatchObject({ state: 'succeeded', commit: 'sessionhash' })
    expect(run.perRepo[0]!.submitRequest).toBeUndefined()
    expect(git.commits).toEqual([])
  })

  it('without a git seam the old session-commits behavior is unchanged', async () => {
    const run = await executePlans([plan('a')], async () => ({ state: 'succeeded', commit: 'abc' }))
    expect(run.perRepo[0]).toMatchObject({ state: 'succeeded', commit: 'abc' })
  })
})

describe('defect retry loop', () => {
  it('retries a failed repo with the failure history until it succeeds', async () => {
    const seen: { repo: string; attempt: number; previousErrors: string[] }[] = []
    const run = await executePlans([plan('a')], async ({ attempt, previousErrors }) => {
      seen.push({ repo: 'a', attempt, previousErrors: [...previousErrors] })
      if (attempt === 1) return { state: 'failed', error: 'tests red' }
      return { state: 'succeeded', commit: 'ok' }
    }, { maxAttempts: 2 })
    expect(run.perRepo[0]!.state).toBe('succeeded')
    expect(run.errors).toEqual([])
    expect(seen).toEqual([
      { repo: 'a', attempt: 1, previousErrors: [] },
      { repo: 'a', attempt: 2, previousErrors: ['tests red'] },
    ])
  })

  it('gives up after the cap and reports the attempt count', async () => {
    let attempts = 0
    const run = await executePlans([plan('a')], async () => {
      attempts += 1
      return { state: 'failed', error: 'still red' }
    }, { maxAttempts: 2 })
    expect(attempts).toBe(2)
    expect(run.perRepo[0]!.state).toBe('failed')
    expect(run.errors).toEqual(['a (after 2 attempts): still red'])
  })

  it('never retries a needs-human outcome', async () => {
    let attempts = 0
    const run = await executePlans([plan('a')], async () => {
      attempts += 1
      return { state: 'needs-human', reason: 'contract cycle' }
    }, { maxAttempts: 3 })
    expect(attempts).toBe(1)
    expect(run.perRepo[0]!.state).toBe('needs-human')
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
