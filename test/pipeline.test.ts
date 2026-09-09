import { describe, expect, it } from 'vitest'
import {
  analyzeImpact,
  blockingAnswersComplete,
  effectiveAnswers,
  planConflicts,
  planDownstream,
  reviewFindings,
  RequirementRecord,
  scaffoldPlans,
} from '../src/pipeline/flow.ts'
import { acmeGraph, cycleGraph, UPDATED_AT } from './fixtures.ts'

const draft = { text: '订单超时自动取消' }

describe('clarification gate (5.2)', () => {
  const questions = [
    {
      id: 'reason-field',
      text: 'order.cancelled 事件是否新增「取消原因」字段？',
      kind: 'select',
      options: [{ label: '新增', recommended: true }, { label: '不新增' }],
      blocking: true,
      context: 'notify-service 与 audit-service 共享该事件契约',
    },
    {
      id: 'compat-window',
      text: '是否要求 30 天内兼容旧订阅方？',
      kind: 'confirm',
      default: '是',
      blocking: false,
    },
  ] as const

  it('effectiveAnswers fills defaults only for non-blocking questions', () => {
    const session = { questions, answers: { 'reason-field': '新增' } }
    expect(effectiveAnswers(session)).toEqual({ 'reason-field': '新增', 'compat-window': '是' })
  })

  it('blockingAnswersComplete requires explicit blocking answers', () => {
    expect(blockingAnswersComplete({ questions })).toBe(false)
    expect(blockingAnswersComplete({ questions, answers: { 'reason-field': '新增' } })).toBe(true)
  })

  it('a spec cannot attach while blocking questions are unanswered', () => {
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).beginClarification(questions)
    expect(() => record.attachSpec(spec())).toThrow(/blocking/)
    const answered = record.resolveClarification({ 'reason-field': '新增' })
    expect(answered.attachSpec(spec()).status).toBe('spec-ready')
  })

  it('rejects answers for unknown question ids and duplicate question ids', () => {
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).beginClarification(questions)
    expect(() => record.resolveClarification({ nope: 'x' })).toThrow(/unknown question/)
    expect(() => RequirementRecord.create('req-1', draft, UPDATED_AT)
      .beginClarification([questions[0]!, { ...questions[0]! }])).toThrow(/unique/)
  })

  it('a draft with sufficient information may skip clarification entirely', () => {
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).attachSpec(spec())
    expect(record.status).toBe('spec-ready')
  })
})

function spec() {
  return {
    text: '订单超时自动取消；新增取消原因字段，兼容旧订阅方 30 天',
    goals: ['order-service 支持超时取消', 'notify-service 通知携带原因'],
    candidateRepos: ['order-service', 'notify-service'],
    constraints: ['30 天兼容窗口'],
    acceptance: ['超时订单自动取消', '通知包含取消原因'],
  }
}

describe('impact analysis (step 2)', () => {
  it('unions candidate repos with the reverse blast radius', () => {
    const analysis = analyzeImpact(acmeGraph(), spec())
    expect(analysis.affectedRepos).toEqual(['audit-service', 'notify-service', 'order-service', 'web-portal'])
    expect(analysis.unknownRepos).toEqual([])
  })

  it('orders execution upstream first with depths', () => {
    const analysis = analyzeImpact(acmeGraph(), spec())
    expect(analysis.topologicalOrder.map(u => [u.repos, u.depth])).toEqual([
      [['order-service'], 0],
      [['audit-service'], 1],
      [['notify-service'], 1],
      [['web-portal'], 2],
    ])
  })

  it('flags the shared event contract as a critical edge', () => {
    const analysis = analyzeImpact(acmeGraph(), spec())
    expect(analysis.criticalEdges).toEqual([
      { from: 'audit-service', to: 'order-service', contract: 'order.cancelled', reason: 'contract' },
      { from: 'notify-service', to: 'order-service', contract: 'order.cancelled', reason: 'contract' },
    ])
  })

  it('reports unknown repos instead of crashing', () => {
    const analysis = analyzeImpact(acmeGraph(), {
      ...spec(),
      candidateRepos: ['order-service', 'brand-new-service'],
    })
    expect(analysis.unknownRepos).toEqual(['brand-new-service'])
    expect(analysis.affectedRepos).toContain('order-service')
    expect(analysis.affectedRepos).not.toContain('brand-new-service')
  })

  it('marks contract cycles inside one unit for human review', () => {
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT)
      .attachSpec({ ...spec(), candidateRepos: ['a', 'b'] })
      .analyze(cycleGraph())
    expect(record.analysis?.topologicalOrder.map(u => [u.repos, u.hasContractCycle])).toEqual([
      [['a', 'b'], true],
      [['c'], false],
    ])
    expect(record.analysis?.criticalEdges.every(edge => edge.reason === 'cycle')).toBe(true)
  })
})

describe('plan scaffolding and review (steps 3-4)', () => {
  it('scaffolds per-repo plans with graph-derived prerequisites', () => {
    const graph = acmeGraph()
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).attachSpec(spec()).analyze(graph)
    const plans = scaffoldPlans(graph, record.analysis!, spec())
    expect(plans.map(p => [p.repo, p.prerequisites])).toEqual([
      ['audit-service', ['order-service']],
      ['notify-service', ['order-service']],
      ['order-service', []],
      ['web-portal', ['audit-service']],
    ])
  })

  it('planDownstream resolves consumers precise to the contract', () => {
    expect(planDownstream(acmeGraph(), 'order-service')).toEqual([
      { repo: 'audit-service', via: 'order.cancelled' },
      { repo: 'notify-service', via: 'order.cancelled' },
    ])
    expect(planDownstream(acmeGraph(), 'notify-service')).toEqual([])
  })
  it('planConflicts detects overlapping write scopes between plans', () => {
    const plans = [
      { ...emptyPlan('order-service'), writeScopes: ['src/events'] },
      { ...emptyPlan('notify-service'), writeScopes: ['src/events/handlers'] },
    ]
    expect(planConflicts(plans)).toEqual([
      { repoA: 'order-service', repoB: 'notify-service', overlaps: ['src/events <-> src/events/handlers'] },
    ])
  })

  it('reviewFindings aggregates breaking changes, conflicts, and critical edges', () => {
    const graph = acmeGraph()
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).attachSpec(spec()).analyze(graph)
    const plans = scaffoldPlans(graph, record.analysis!, spec())
    plans[2] = {
      ...plans[2]!,
      contractImpact: {
        breaking: ['order.cancelled 新增 reason 字段'],
        downstream: [{ repo: 'notify-service', via: 'order.cancelled' }],
      },
    }
    const findings = reviewFindings(graph, record.analysis!, plans)
    expect(findings.breakingChanges).toEqual([
      { repo: 'order-service', breaking: ['order.cancelled 新增 reason 字段'] },
    ])
    expect(findings.conflicts).toEqual([])
    expect(findings.criticalEdges.length).toBe(2)
  })
})

function emptyPlan(repo: string) {
  return {
    repo,
    summary: 's',
    changes: [],
    writeScopes: [],
    contractImpact: { breaking: [], downstream: [] },
    prerequisites: [],
    acceptance: [],
  }
}

describe('requirement record state machine', () => {
  it('walks the full chain draft -> dispatched and persists', () => {
    const graph = acmeGraph()
    const record = RequirementRecord.create('req-42', draft, UPDATED_AT)
      .attachSpec(spec())
      .analyze(graph)
    const plans = scaffoldPlans(graph, record.analysis!, spec()).map(plan =>
      plan.repo === 'order-service'
        ? { ...plan, summary: '超时扫描 + 取消发布', writeScopes: ['src/cancel'] }
        : { ...plan, summary: '处理取消原因' },
    )
    const planned = record.attachPlans(plans)
    expect(planned.status).toBe('planned')
    const doc = planned.dispatch().toDocument()
    expect(doc.version).toBe(1)
    expect(doc.id).toBe('req-42')
    expect(doc.status).toBe('dispatched')
    expect(doc.plans).toHaveLength(4)
    const restored = RequirementRecord.load(doc)
    expect(restored.status).toBe('dispatched')
  })

  it('rejects out-of-order transitions and invalid plans', () => {
    expect(() => RequirementRecord.create('req-1', draft, UPDATED_AT).dispatch()).toThrow(/planned/)
    expect(() => RequirementRecord.create('req-1', draft, UPDATED_AT).analyze(acmeGraph())).toThrow(/spec/)
    const record = RequirementRecord.create('req-1', draft, UPDATED_AT).attachSpec(spec()).analyze(acmeGraph())
    expect(() => record.attachPlans([{ ...emptyPlan('shared-sdk') }])).toThrow(/blast radius/)
    expect(() => record.attachPlans([
      { ...emptyPlan('order-service'), prerequisites: ['notify-service'] },
      { ...emptyPlan('notify-service') },
    ])).not.toThrow()
    expect(() => record.attachPlans([{ ...emptyPlan('') }])).toThrow(/non-empty/)
  })

  it('requires a spec to name at least one repo', () => {
    expect(() => RequirementRecord.create('req-1', draft, UPDATED_AT)
      .attachSpec({ ...spec(), candidateRepos: [] })).toThrow(/candidate repo/)
  })
})
