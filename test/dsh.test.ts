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

describe('hostCapabilities probe', () => {
  it('reports nothing on a plain cordis context and detects fakes', () => {
    const bare = hostCapabilities(new Context())
    expect(bare.tools).toBeUndefined()
    expect(bare.subagents).toBeUndefined()
    const fake = hostCapabilities({
      tools: { register: () => () => {} },
      subagents: { start: async () => ({ id: 'x', result: Promise.resolve({ output: [], stopReason: 'end' }) }) },
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
    const subagents: SubagentsRuntimeLike = {
      async start(request) {
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
            stopReason: 'end_turn',
          }),
        }
      },
    }
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
      parent: { kind: 'fake-agent' },
      spec,
      upstream: { results: [] },
      signal: new AbortController().signal,
    })
    const outcomeA = await task({ plan: planA, repoPath: 'D:/a' })
    expect(outcomeA).toEqual({
      state: 'succeeded',
      sessionId: 'sess-1',
      commit: 'deadbeef1',
      diffSummary: 'src/x.ts',
    })
    const outcomeB = await task({ plan: planB, repoPath: 'D:/b' })
    expect(outcomeB).toMatchObject({ state: 'succeeded', commit: 'deadbeef2' })
    expect(started).toEqual(['repo-board/a', 'repo-board/b'])
  })

  it('a session without structured output fails with its text', async () => {
    const subagents: SubagentsRuntimeLike = {
      async start() {
        return {
          id: 'sess-x',
          result: Promise.resolve({
            output: [{ type: 'text', text: '需求矛盾，无法继续' }],
            structured: undefined,
            stopReason: 'end_turn',
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
    } })
    expect(outcome).toEqual({
      state: 'failed',
      sessionId: 'sess-x',
      error: 'repo session ended without structured output (stopReason: end_turn): 需求矛盾，无法继续',
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
      async start(request: { label?: string }) {
        subagentCalls.push(request.label ?? '')
        return {
          id: 'sess-' + subagentCalls.length,
          result: Promise.resolve({
            output: [{ type: 'text', text: 'ok' }],
            structured: { summary: 'done ' + (request.label ?? ''), commit: 'c' + subagentCalls.length, changedFiles: ['src/main.ts'] },
            stopReason: 'end_turn',
          }),
        }
      },
    }
    toolsPlugin.apply(ctx)
    return { ctx, registry, subagentCalls }
  }

  it('registers all seven tools on a capable host and none on a bare one', async () => {
    const { ctx, registry } = await setup()
    expect([...registry.definitions.keys()].sort()).toEqual([
      'repo_board_clarify',
      'repo_board_dispatch',
      'repo_board_execute',
      'repo_board_graph',
      'repo_board_plans',
      'repo_board_scan',
      'repo_board_spec',
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
      return (args: unknown) => definition.execute(args, toolExec(args))
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
})
