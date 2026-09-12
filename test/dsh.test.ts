import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RepoBoardService from '../src/service.ts'
import * as toolsPlugin from '../src/tools.ts'
import type { RawToolDefinition, ToolRunContext } from '../src/dsh/types.ts'
import { hostCapabilities } from '../src/dsh/types.ts'
import { buildRepoSessionPrompt, repoSessionOutputSchema } from '../src/dsh/prompt.ts'
import { buildRepoSessionTask } from '../src/dsh/session-task.ts'
import type { SubagentsRuntimeLike } from '../src/dsh/types.ts'
import type { RepoModificationPlan, RequirementSpec } from '../src/pipeline/types.ts'

// Separate from service.test.ts's .tmp: vitest runs test files in parallel
// and that file's afterAll would otherwise delete this file's mid-run state.
const tmpRoot = join('test', '.tmp-dsh')

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

function toolExec(args: unknown): ToolRunContext {
  return {
    callId: 'call-1',
    name: 'test',
    arguments: args,
    agent: { kind: 'fake-agent' },
    signal: new AbortController().signal,
  }
}

/**
 * Mirror of the host's lossless-JSON output rule (dsh-util-values
 * walkJsonValue): one undefined property value rejects the whole tool
 * output ("value is not lossless JSON"). JSON.stringify silently drops
 * undefined, so plain toEqual assertions never catch this class of bug.
 */
function assertLosslessJson(value: unknown, ancestors: Set<object> = new Set(), path = 'output'): void {
  if (value === undefined) throw new Error(`${path} is undefined - the real host rejects this output`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    expect(Number.isFinite(value) && !Object.is(value, -0)).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertLosslessJson(item, ancestors, `${path}[${index}]`)
    return
  }
  if (typeof value === 'object') {
    expect(ancestors.has(value)).toBe(false)
    ancestors.add(value)
    for (const [key, entry] of Object.entries(value)) assertLosslessJson(entry, ancestors, `${path}.${key}`)
    ancestors.delete(value)
    return
  }
  throw new Error(`${path} is not lossless JSON (${typeof value})`)
}

describe('hostCapabilities probe', () => {
  it('reports nothing on a plain cordis context and detects fakes', () => {
    const bare = hostCapabilities(new Context())
    expect(bare.tools).toBeUndefined()
    expect(bare.subagents).toBeUndefined()
    const fake = hostCapabilities({
      tools: { register: () => () => {} },
      subagents: { start: async () => ({ id: 'x', result: Promise.resolve({ output: [], stopReason: 'completed' }) }) },
    })
    expect(fake.tools).toBeDefined()
    expect(fake.subagents).toBeDefined()
  })
})

describe('buildRepoSessionPrompt', () => {
  it('carries spec, plan, repo path, and upstream context', () => {
    const spec: RequirementSpec = {
      text: '订单超时自动取消',
      goals: ['order 支持超时取消', 'notify 携带原因'],
      candidateRepos: ['order-service', 'notify-service'],
      constraints: ['30 天兼容窗口'],
      acceptance: ['超时订单自动取消'],
    }
    const plan: RepoModificationPlan = {
      repo: 'notify-service',
      summary: '处理取消原因',
      changes: [{ target: 'src/handler.ts', description: '读取 reason 字段' }],
      writeScopes: ['src/handler.ts'],
      contractImpact: { breaking: [], downstream: [] },
      prerequisites: ['order-service'],
      acceptance: [],
    }
    const prompt = buildRepoSessionPrompt({
      plan,
      spec,
      repoPath: 'D:/checkouts/notify-service',
      upstreamResults: [{ repo: 'order-service', summary: '已发布 order.cancelled v2', commit: 'abc1234' }],
    })
    expect(prompt).toContain('订单超时自动取消')
    expect(prompt).toContain('你负责的仓库：notify-service')
    expect(prompt).toContain('D:/checkouts/notify-service')
    expect(prompt).toContain('order-service（commit abc1234）：已发布 order.cancelled v2')
    expect(prompt).toContain('只修改 notify-service 仓库')
    expect(prompt).toContain('不要 push')
  })
})

describe('buildRepoSessionTask with a fake subagent runtime', () => {
  it('maps structured output to a succeeded outcome and feeds upstream', async () => {
    const started: string[] = []
    const parents: object[] = []
    const providers: string[] = []
    const subagents: SubagentsRuntimeLike = {
      async start(provider, request) {
        providers.push(provider)
        parents.push(request.parent)
        const label = request.label ?? ''
        started.push(label)
        return {
          id: 'sess-' + started.length,
          result: Promise.resolve({
            output: [{ type: 'text', text: 'done' }],
            structured: {
              summary: 'completed ' + label,
              commit: 'deadbeef' + started.length,
              changedFiles: ['src/x.ts'],
            },
            stopReason: 'completed',
          }),
        }
      },
    }
    const fakeParent = { kind: 'fake-agent' }
    const spec: RequirementSpec = {
      text: 't',
      goals: [],
      candidateRepos: ['a'],
      constraints: [],
      acceptance: [],
    }
    const planA: RepoModificationPlan = {
      repo: 'a', summary: 's', changes: [], writeScopes: [],
      contractImpact: { breaking: [], downstream: [] }, prerequisites: [], acceptance: [],
    }
    const planB: RepoModificationPlan = {
      repo: 'b', summary: 's', changes: [], writeScopes: [],
      contractImpact: { breaking: [], downstream: [] }, prerequisites: ['a'], acceptance: [],
    }
    const task = buildRepoSessionTask({
      subagents,
      parent: fakeParent,
      spec,
      upstream: { results: [] },
      signal: new AbortController().signal,
    })
    const outcomeA = await task({ plan: planA, repoPath: 'D:/a', branch: 'ai-delivery/req-1/a', attempt: 1, previousErrors: [] })
    expect(outcomeA).toEqual({
      state: 'succeeded',
      sessionId: 'sess-1',
      commit: 'deadbeef1',
      diffSummary: 'src/x.ts',
    })
    const outcomeB = await task({ plan: planB, repoPath: 'D:/b', branch: 'ai-delivery/req-1/b', attempt: 1, previousErrors: [] })
    expect(outcomeB).toMatchObject({ state: 'succeeded', commit: 'deadbeef2' })
    expect(started).toEqual(['repo-board/a', 'repo-board/b'])
    // Real-host contract: provider name first, parent agent forwarded.
    expect(providers).toEqual(['spawn', 'spawn'])
    expect(parents).toEqual([fakeParent, fakeParent])
  })

  it('a session without structured output fails with its text', async () => {
    const subagents: SubagentsRuntimeLike = {
      async start() {
        return {
          id: 'sess-x',
          result: Promise.resolve({
            output: [{ type: 'text', text: '需求矛盾，无法继续' }],
            structured: undefined,
            stopReason: 'completed',
          }),
        }
      },
    }
    const task = buildRepoSessionTask({
      subagents,
      parent: {},
      spec: { text: 't', goals: [], candidateRepos: ['a'], constraints: [], acceptance: [] },
      upstream: { results: [] },
      signal: new AbortController().signal,
    })
    const outcome = await task({ plan: {
      repo: 'a', summary: 's', changes: [], writeScopes: [],
      contractImpact: { breaking: [], downstream: [] }, prerequisites: [], acceptance: [],
    }, branch: '', attempt: 1, previousErrors: [] })
    expect(outcome).toEqual({
      state: 'failed',
      sessionId: 'sess-x',
      error: 'repo session ended without structured output (stopReason: completed): 需求矛盾，无法继续',
    })
  })
})

describe('tools plugin end-to-end over demo repos', () => {
  const graphPath = join(tmpRoot, 'tools-graph.json')

  interface FakeRegistry {
    definitions: Map<string, RawToolDefinition>
    register(definition: RawToolDefinition): () => void
  }

  function fakeRegistry(): FakeRegistry {
    const definitions = new Map<string, RawToolDefinition>()
    return {
      definitions,
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    }
  }

  async function setup() {
    const ctx = new Context()
    await ctx.plugin(RepoBoardService)
    const registry = fakeRegistry()
    ;(ctx as unknown as { tools: unknown }).tools = registry
    const subagentCalls: string[] = []
    ;(ctx as unknown as { subagents: unknown }).subagents = {
      async start(_provider: string, request: { label?: string }) {
        subagentCalls.push(request.label ?? '')
        return {
          id: 'sess-' + subagentCalls.length,
          result: Promise.resolve({
            output: [{ type: 'text', text: 'ok' }],
            structured: { summary: 'done ' + (request.label ?? ''), commit: 'c' + subagentCalls.length, changedFiles: ['src/main.ts'] },
            stopReason: 'completed',
          }),
        }
      },
    }
    toolsPlugin.apply(ctx)
    return { ctx, registry, subagentCalls }
  }

  it('registers all eight tools on a capable host and none on a bare one', async () => {
    const { ctx, registry } = await setup()
    expect([...registry.definitions.keys()].sort()).toEqual([
      'repo_board_clarify',
      'repo_board_dispatch',
      'repo_board_execute',
      'repo_board_graph',
      'repo_board_plans',
      'repo_board_scan',
      'repo_board_spec',
      'repo_board_submit',
    ])
    const bareCtx = new Context()
    toolsPlugin.apply(bareCtx)
    void ctx
  })

  it('runs the whole pipeline: scan -> dispatch -> clarify -> spec -> plans -> execute', async () => {
    const { ctx, registry, subagentCalls } = await setup()
    const tool = (name: string) => {
      const definition = registry.definitions.get(name)
      if (definition === undefined) throw new Error('tool not registered: ' + name)
      return async (args: unknown) => {
        const output = await definition.execute(args, toolExec(args))
        // Every tool output must survive the host's lossless-JSON snapshot.
        assertLosslessJson(output)
        return output
      }
    }

    const scan = await tool('repo_board_scan')({
      project: 'acme-demo',
      graphPath,
      repos: [
        { key: 'shared-sdk', path: join('test', 'demo-repos', 'shared-sdk') },
        { key: 'order-service', path: join('test', 'demo-repos', 'order-service') },
        { key: 'notify-service', path: join('test', 'demo-repos', 'notify-service') },
        { key: 'web-portal', path: join('test', 'demo-repos', 'web-portal') },
      ],
    })
    const scanResult = scan as { edges: { from: string; to: string; type: string }[] }
    expect(scanResult.edges.some(e => e.from === 'notify-service' && e.to === 'order-service' && e.type === 'contract')).toBe(true)

    const impact = await tool('repo_board_graph')({ action: 'impact', repo: 'order-service' })
    expect((impact as { impact: string[] }).impact).toEqual(['notify-service', 'web-portal'])

    const dispatch = await tool('repo_board_dispatch')({ text: '订单超时自动取消' })
    const requirementId = (dispatch as { requirementId: string }).requirementId
    expect(requirementId).toBe('req-1')

    const clarify = await tool('repo_board_clarify')({
      requirementId,
      questions: [
        {
          id: 'reason-field',
          text: 'order.cancelled 是否新增取消原因字段？',
          kind: 'select',
          options: [{ label: '新增', recommended: true }, { label: '不新增' }],
          blocking: true,
          context: 'notify-service 消费该事件',
        },
      ],
      answers: { 'reason-field': '新增' },
    })
    expect((clarify as { blockingAnswered: string }).blockingAnswered).toBe('1/1')

    const spec = await tool('repo_board_spec')({
      requirementId,
      spec: {
        text: '订单超时自动取消；order.cancelled 新增 reason 字段',
        goals: ['超时取消', '通知携带原因'],
        candidateRepos: ['order-service', 'notify-service'],
        constraints: [],
        acceptance: ['超时订单自动取消'],
      },
    })
    const specResult = spec as {
      analysis: { affectedRepos: string[]; criticalEdges: unknown[] }
      planSkeletons: { repo: string; prerequisites: string[] }[]
    }
    expect(specResult.analysis.affectedRepos).toEqual(['notify-service', 'order-service', 'web-portal'])
    expect(specResult.analysis.criticalEdges.length).toBeGreaterThan(0)
    const orderSkeleton = specResult.planSkeletons.find(skeleton => skeleton.repo === 'order-service')!
    const notifySkeleton = specResult.planSkeletons.find(skeleton => skeleton.repo === 'notify-service')!
    expect(notifySkeleton.prerequisites).toEqual(['order-service'])

    const plans = await tool('repo_board_plans')({
      requirementId,
      plans: [
        {
          ...orderSkeleton,
          summary: '超时扫描与取消发布',
          changes: [{ target: 'src/cancel.ts', description: '新增超时扫描' }],
          writeScopes: ['src/cancel.ts'],
          contractImpact: { breaking: ['order.cancelled 新增 reason 字段'], downstream: [] },
        },
        { ...notifySkeleton, summary: '处理取消原因' },
      ],
    })
    const plansResult = plans as { findings: { breakingChanges: { repo: string }[]; conflicts: unknown[] }; status: string }
    expect(plansResult.findings.breakingChanges).toEqual([
      { repo: 'order-service', breaking: ['order.cancelled 新增 reason 字段'] },
    ])
    expect(plansResult.status).toBe('planned')

    const execution = await tool('repo_board_execute')({ requirementId })
    const run = (execution as { run: { perRepo: { repo: string; state: string; commit?: string }[]; errors: string[] }; status: string }).run
    expect(run.errors).toEqual([])
    expect(run.perRepo.map(entry => [entry.repo, entry.state])).toEqual([
      ['order-service', 'succeeded'],
      ['notify-service', 'succeeded'],
    ])
    expect(subagentCalls).toEqual(['repo-board/order-service', 'repo-board/notify-service'])
    expect((execution as { status: string }).status).toBe('dispatched')

    const requirements = (ctx as { repoBoard: RepoBoardService }).repoBoard.listRequirements()
    expect(requirements).toHaveLength(1)
    expect(requirements[0]!.status).toBe('dispatched')
    expect(requirements[0]!.run?.perRepo.every(entry => entry.state === 'succeeded')).toBe(true)

    const reopenCtx = new Context()
    await reopenCtx.plugin(RepoBoardService)
    await (reopenCtx as { repoBoard: RepoBoardService }).repoBoard.open('acme-demo', graphPath)
    const reopened = (reopenCtx as { repoBoard: RepoBoardService }).repoBoard.listRequirements()
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.id).toBe('req-1')
    expect(reopened[0]!.status).toBe('dispatched')
    expect((reopenCtx as { repoBoard: RepoBoardService }).repoBoard.getRequirement('req-1')?.toDocument().run).toBeDefined()
  })

  it('rejects invalid arguments with clear errors', async () => {
    const { ctx, registry } = await setup()
    const scanTool = registry.definitions.get('repo_board_scan')!
    await expect(scanTool.execute({ project: 'x', graphPath: 'y', repos: [] }, toolExec({})))
      .rejects.toThrow(/repos must not be empty/)
    const dispatchTool = registry.definitions.get('repo_board_dispatch')!
    await expect(dispatchTool.execute({ text: '' }, toolExec({}))).rejects.toThrow(/text/)
    const graphTool = registry.definitions.get('repo_board_graph')!
    await expect(graphTool.execute({ action: 'impact' }, toolExec({}))).rejects.toThrow(/repo/)
    void ctx
  })

  it('a follow-up clarification batch keeps earlier recorded answers', async () => {
    const { registry } = await setup()
    const tool = (name: string) => {
      const definition = registry.definitions.get(name)
      if (definition === undefined) throw new Error('tool not registered: ' + name)
      return async (args: unknown) => {
        const output = await definition.execute(args, toolExec(args))
        assertLosslessJson(output)
        return output
      }
    }

    const graphPath2 = join(tmpRoot, 'clarify-graph.json')
    await tool('repo_board_scan')({
      project: 'clarify-demo',
      graphPath: graphPath2,
      repos: [{ key: 'order-service', path: join('test', 'demo-repos', 'order-service') }],
    })
    const dispatch = await tool('repo_board_dispatch')({ text: '订单超时自动取消' })
    const requirementId = (dispatch as { requirementId: string }).requirementId

    const blocking = {
      id: 'reason-field',
      text: 'order.cancelled 是否新增取消原因字段？',
      kind: 'select',
      options: [{ label: '新增', recommended: true }, { label: '不新增' }],
      blocking: true,
      context: 'notify-service 消费该事件',
    }
    const optional = {
      id: 'compat-window',
      text: '是否要求 30 天兼容？',
      kind: 'confirm',
      default: '是',
      blocking: false,
    }
    const added = {
      id: 'notify-channel',
      text: '取消后通知渠道？',
      kind: 'select',
      options: [{ label: 'push' }, { label: 'email' }],
      blocking: false,
    }

    // Batch 1: two questions, answer the blocking one.
    const first = await tool('repo_board_clarify')({
      requirementId,
      questions: [blocking, optional],
      answers: { 'reason-field': '新增' },
    })
    expect((first as { blockingAnswered: string }).blockingAnswered).toBe('1/1')

    // Batch 2 (follow-up round): extend the set, supply only the new answer.
    // Before the fix this wiped the batch-1 answer and reopened the gate.
    const second = await tool('repo_board_clarify')({
      requirementId,
      questions: [blocking, optional, added],
      answers: { 'notify-channel': 'push' },
    })
    expect((second as { blockingAnswered: string }).blockingAnswered).toBe('1/1')

    // The spec still attaches: the human's batch-1 answer survived.
    const spec = await tool('repo_board_spec')({
      requirementId,
      spec: {
        text: '订单超时自动取消；新增 reason 字段',
        goals: [],
        candidateRepos: ['order-service'],
        constraints: [],
        acceptance: [],
      },
    })
    expect((spec as { status: string }).status).toBe('analyzed')
  })

  it('manual commit policy: requirement branch, submit gate, and host-side commit end to end', async () => {
    // One real git checkout the fake session actually edits.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { NodeCommandRunner, GitClient } = await import('../src/exec/git.ts')
    const repoDir = join(tmpRoot, 'manual-repo')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'manual-repo', version: '1.0.0' }), 'utf8')
    const runner = new NodeCommandRunner()
    expect((await runner.run('git', ['init'], repoDir)).exitCode).toBe(0)

    // Setup with a session that parses its repo path from the prompt and
    // writes a real file, honoring the manual policy's no-commit rule.
    const ctx = new Context()
    await ctx.plugin(RepoBoardService)
    const registry = fakeRegistry()
    ;(ctx as unknown as { tools: unknown }).tools = registry
    ;(ctx as unknown as { subagents: unknown }).subagents = {
      async start(_provider: string, request: { prompt: { type: string; text?: string }[] }) {
        const prompt = request.prompt.map(block => block.type === 'text' ? (block.text ?? '') : '').join('\n')
        const pathMatch = /本地路径：(.+)/.exec(prompt)
        expect(pathMatch).not.toBeNull()
        await mkdir(join(pathMatch![1]!, 'src'), { recursive: true })
        await writeFile(join(pathMatch![1]!, 'src', 'feature.ts'), 'export const reason = true\n', 'utf8')
        // Manual policy forbids committing - verify the brief says so.
        expect(prompt).toContain('不要执行任何 git commit')
        return {
          id: 'sess-manual',
          result: Promise.resolve({
            output: [{ type: 'text', text: 'done' }],
            structured: { summary: '新增 reason 支持', changedFiles: ['src/feature.ts'] },
            stopReason: 'completed',
          }),
        }
      },
    }
    toolsPlugin.apply(ctx)
    const tool = (name: string) => {
      const definition = registry.definitions.get(name)
      if (definition === undefined) throw new Error('tool not registered: ' + name)
      return async (args: unknown) => {
        const output = await definition.execute(args, toolExec(args))
        // Every tool output must survive the host's lossless-JSON snapshot.
        assertLosslessJson(output)
        return output
      }
    }

    const manualGraphPath = join(tmpRoot, 'manual-graph.json')
    await tool('repo_board_scan')({ project: 'manual-demo', graphPath: manualGraphPath, repos: [{ key: 'manual-repo', path: repoDir }] })
    const dispatch = await tool('repo_board_dispatch')({ text: '新增取消原因' })
    const requirementId = (dispatch as { requirementId: string }).requirementId

    const spec = await tool('repo_board_spec')({
      requirementId,
      spec: {
        text: '新增取消原因',
        goals: ['携带 reason'],
        candidateRepos: ['manual-repo'],
        constraints: [],
        acceptance: ['reason 可用'],
      },
    })
    const skeleton = (spec as { planSkeletons: { repo: string; prerequisites: string[] }[] }).planSkeletons[0]!
    await tool('repo_board_plans')({
      requirementId,
      plans: [{ ...skeleton, summary: '新增 reason 字段', changes: [{ target: 'src/feature.ts', description: '导出 reason' }] }],
    })

    // Execute under the manual policy: the repo parks at submit-pending.
    const execution = await tool('repo_board_execute')({ requirementId, commitPolicy: 'manual' })
    const execResult = execution as {
      run: { perRepo: { repo: string; state: string; submitRequest?: { branch: string; changedFiles: string[] } }[] }
      next: string
    }
    expect(execResult.run.perRepo[0]!.state).toBe('submit-pending')
    expect(execResult.run.perRepo[0]!.submitRequest).toEqual({
      branch: 'ai-delivery/' + requirementId + '/manual-repo',
      summary: '新增 reason 字段',
      // The fresh checkout has no commits, so package.json counts as changed too.
      changedFiles: ['package.json', 'src/feature.ts'],
    })
    expect(execResult.next).toContain('repo_board_submit')

    // The checkout sits on the requirement branch with the change uncommitted.
    const git = new GitClient(runner)
    expect(await git.currentBranch(repoDir)).toBe('ai-delivery/' + requirementId + '/manual-repo')

    // Approve: the host commits on the requirement branch.
    const submit = await tool('repo_board_submit')({ requirementId, repo: 'manual-repo', decision: 'approve' })
    const submitResult = submit as { state: string; commit: string }
    expect(submitResult.state).toBe('submitted')
    expect(submitResult.commit).toMatch(/^[0-9a-f]{40}$/)
    const status = await git.status(repoDir)
    expect(status.clean).toBe(true)
    expect(status.branch).toBe('ai-delivery/' + requirementId + '/manual-repo')

    // Approving twice refuses: the repo is no longer pending.
    await expect(tool('repo_board_submit')({ requirementId, repo: 'manual-repo', decision: 'approve' }))
      .rejects.toThrow(/not waiting for a submit decision/)
  })

  it('auto commit policy still enforces branch discipline: the session commits on the requirement branch, never the trunk', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { NodeCommandRunner, GitClient } = await import('../src/exec/git.ts')
    const repoDir = join(tmpRoot, 'auto-repo')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'auto-repo', version: '1.0.0' }), 'utf8')
    const runner = new NodeCommandRunner()
    expect((await runner.run('git', ['init'], repoDir)).exitCode).toBe(0)
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid']
    expect((await runner.run('git', [...identity, 'add', '-A'], repoDir)).exitCode).toBe(0)
    expect((await runner.run('git', [...identity, 'commit', '-m', 'init'], repoDir)).exitCode).toBe(0)
    const git = new GitClient(runner)
    const trunk = await git.currentBranch(repoDir)
    const trunkHead = (await runner.run('git', ['rev-parse', 'HEAD'], repoDir)).stdout.trim()

    const prompts: string[] = []
    const ctx = new Context()
    await ctx.plugin(RepoBoardService)
    const registry = fakeRegistry()
    ;(ctx as unknown as { tools: unknown }).tools = registry
    ;(ctx as unknown as { subagents: unknown }).subagents = {
      async start(_provider: string, request: { prompt: { type: string; text?: string }[] }) {
        const prompt = request.prompt.map(block => block.type === 'text' ? (block.text ?? '') : '').join('\n')
        prompts.push(prompt)
        const pathMatch = /本地路径：(.+)/.exec(prompt)
        expect(pathMatch).not.toBeNull()
        // The brief must truthfully say the scheduler prepared the branch -
        // and the session (auto policy) commits on it itself.
        expect(prompt).toContain('调度方已切好')
        expect(prompt).toContain('用 git 提交你的修改')
        const cwd = pathMatch![1]!
        await writeFile(join(cwd, 'src-feature.ts'), 'export const x = 1\n', 'utf8')
        expect((await runner.run('git', [...identity, 'add', '-A'], cwd)).exitCode).toBe(0)
        expect((await runner.run('git', [...identity, 'commit', '-m', 'feat: x'], cwd)).exitCode).toBe(0)
        return {
          id: 'sess-auto',
          result: Promise.resolve({
            output: [{ type: 'text', text: 'done' }],
            structured: {
              summary: '新增 x',
              commit: (await runner.run('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim(),
              changedFiles: ['src-feature.ts'],
            },
            stopReason: 'completed',
          }),
        }
      },
    }
    toolsPlugin.apply(ctx)
    const tool = (name: string) => {
      const definition = registry.definitions.get(name)
      if (definition === undefined) throw new Error('tool not registered: ' + name)
      return async (args: unknown) => {
        const output = await definition.execute(args, toolExec(args))
        assertLosslessJson(output)
        return output
      }
    }

    const autoGraphPath = join(tmpRoot, 'auto-graph.json')
    await tool('repo_board_scan')({ project: 'auto-demo', graphPath: autoGraphPath, repos: [{ key: 'auto-repo', path: repoDir }] })
    const dispatch = await tool('repo_board_dispatch')({ text: '新增 x' })
    const requirementId = (dispatch as { requirementId: string }).requirementId
    const spec = await tool('repo_board_spec')({
      requirementId,
      spec: {
        text: '新增 x',
        goals: [],
        candidateRepos: ['auto-repo'],
        constraints: [],
        acceptance: [],
      },
    })
    const skeleton = (spec as { planSkeletons: { repo: string }[] }).planSkeletons[0]!
    await tool('repo_board_plans')({ requirementId, plans: [{ ...skeleton, summary: '新增 x' }] })

    const execution = await tool('repo_board_execute')({ requirementId })
    const run = (execution as { run: { perRepo: { repo: string; state: string }[] } }).run
    expect(run.perRepo[0]).toMatchObject({ repo: 'auto-repo', state: 'succeeded' })

    // The session's commit landed on the requirement branch, never the trunk.
    expect(await git.currentBranch(repoDir)).toBe('ai-delivery/' + requirementId + '/auto-repo')
    expect((await runner.run('git', ['rev-parse', trunk], repoDir)).stdout.trim()).toBe(trunkHead)
    expect((await runner.run('git', ['rev-parse', 'HEAD'], repoDir)).stdout.trim()).not.toBe(trunkHead)
  })

  it('re-dispatch carries the failure history into the retry prompt and merges runs', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const repoDir = join(tmpRoot, 'retry-repo')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'retry-repo', version: '1.0.0' }), 'utf8')

    const prompts: string[] = []
    let calls = 0
    const ctx = new Context()
    await ctx.plugin(RepoBoardService)
    const registry = fakeRegistry()
    ;(ctx as unknown as { tools: unknown }).tools = registry
    ;(ctx as unknown as { subagents: unknown }).subagents = {
      async start(_provider: string, request: { prompt: { type: string; text?: string }[] }) {
        calls += 1
        prompts.push(request.prompt.map(block => block.type === 'text' ? (block.text ?? '') : '').join('\n'))
        if (calls === 1) {
          // No structured output: the session-task maps this to a failure.
          return {
            id: 'sess-retry-1',
            result: Promise.resolve({ output: [{ type: 'text', text: '构建失败' }], stopReason: 'completed' }),
          }
        }
        return {
          id: 'sess-retry-2',
          result: Promise.resolve({
            output: [{ type: 'text', text: 'ok' }],
            structured: { summary: '修复完成', changedFiles: ['src/fix.ts'] },
            stopReason: 'completed',
          }),
        }
      },
    }
    toolsPlugin.apply(ctx)
    const tool = (name: string) => {
      const definition = registry.definitions.get(name)
      if (definition === undefined) throw new Error('tool not registered: ' + name)
      return async (args: unknown) => {
        const output = await definition.execute(args, toolExec(args))
        assertLosslessJson(output)
        return output
      }
    }

    const retryGraphPath = join(tmpRoot, 'retry-graph.json')
    await tool('repo_board_scan')({ project: 'retry-demo', graphPath: retryGraphPath, repos: [{ key: 'retry-repo', path: repoDir }] })
    const dispatch = await tool('repo_board_dispatch')({ text: '修复构建' })
    const requirementId = (dispatch as { requirementId: string }).requirementId
    const spec = await tool('repo_board_spec')({
      requirementId,
      spec: {
        text: '修复构建',
        goals: [],
        candidateRepos: ['retry-repo'],
        constraints: [],
        acceptance: [],
      },
    })
    const skeleton = (spec as { planSkeletons: { repo: string }[] }).planSkeletons[0]!
    await tool('repo_board_plans')({ requirementId, plans: [{ ...skeleton, summary: '修复构建' }] })

    // First run: the repo session fails.
    const first = await tool('repo_board_execute')({ requirementId })
    const firstRun = (first as { run: { perRepo: { repo: string; state: string }[] } }).run
    expect(firstRun.perRepo[0]).toMatchObject({ repo: 'retry-repo', state: 'failed' })

    // Second call re-dispatches: the retry prompt carries the prior failure.
    const second = await tool('repo_board_execute')({ requirementId })
    const secondRun = (second as { run: { perRepo: { repo: string; state: string; commit?: string }[] } }).run
    expect(secondRun.perRepo[0]).toMatchObject({ repo: 'retry-repo', state: 'succeeded' })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('这是第 2 次尝试')
    expect(prompts[1]).toContain('retry-repo: repo session ended without structured output')
    expect(prompts[1]).toContain('构建失败')
  })
})
