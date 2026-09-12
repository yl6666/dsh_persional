/**
 * Prompt and schema builders for the one-session-per-repo executor binding
 * (docs/product-design.md 6). Pure functions: fully unit-testable, no host
 * imports.
 * @module dsh-repo-board
 */

import type { JsonSchemaNode } from './types.ts'
import type { RepoModificationPlan, RequirementSpec } from '../pipeline/types.ts'

/** Structured output one repo session is asked to produce. */
export interface RepoSessionOutput {
  readonly summary: string
  readonly commit?: string
  readonly changedFiles: readonly string[]
}

/** Output schema sent with the subagent start request. */
export const repoSessionOutputSchema: JsonSchemaNode & { type: 'object' } = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what was changed and why, one paragraph' },
    commit: { type: 'string', description: 'the commit hash, when changes were committed' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'files created or modified' },
  },
  required: ['summary', 'changedFiles'],
}

function bulletList(items: readonly string[], empty: string): string {
  return items.length === 0 ? '（' + empty + '）' : items.map(item => '- ' + item).join('\n')
}

/**
 * The full brief one repo session receives: the repo's plan in context, the
 * upstream results it may build on, and the reporting contract.
 */
export function buildRepoSessionPrompt(input: {
  readonly plan: RepoModificationPlan
  readonly spec: RequirementSpec
  readonly repoPath?: string
  readonly upstreamResults: readonly { repo: string; summary: string; commit?: string }[]
  /** Requirement branch the executor has prepared for this repo. */
  readonly branch?: string
  /** False when the host commits after human approval; the session must not commit. */
  readonly selfCommit?: boolean
  /**
   * True when the path is not the root of its own git work tree. Any git
   * command run there resolves into the ENCLOSING repository, so the
   * session must not touch git at all - it just edits files.
   */
  readonly noGit?: boolean
  /** 1-based attempt number for defect retries. */
  readonly attempt?: number
  /** Failure history from previous attempts (17.3 defect loop). */
  readonly previousErrors?: readonly string[]
}): string {
  const { plan, spec, repoPath, upstreamResults } = input
  const selfCommit = input.selfCommit ?? true
  const lines: string[] = []
  lines.push('你是多仓协同开发中负责单仓修改的执行者（一会话一仓）。')
  lines.push('只承担当前仓库的实现职责：基于需求、方案与代码事实工作，禁止编造信息；信息不足时明确提出问题而不是自行假设。')
  if ((input.attempt ?? 1) > 1) {
    lines.push('')
    lines.push('## 重试')
    lines.push('这是第 ' + input.attempt + ' 次尝试。此前失败原因（逐条修复，不要重复同样的错误）：')
    lines.push(bulletList(input.previousErrors ?? [], '无记录'))
  }
  lines.push('')
  lines.push('## 需求规格')
  lines.push(spec.text)
  lines.push('目标：')
  lines.push(bulletList(spec.goals, '无子目标拆分'))
  lines.push('约束：')
  lines.push(bulletList(spec.constraints, '无额外约束'))
  lines.push('验收标准：')
  lines.push(bulletList(spec.acceptance, '未给出'))
  lines.push('')
  lines.push('## 你负责的仓库：' + plan.repo)
  if (repoPath !== undefined) lines.push('本地路径：' + repoPath)
  if (input.branch !== undefined && input.branch !== '') {
    lines.push('需求分支：' + input.branch + '（调度方已切好；不要切换、创建或删除分支）')
  }
  lines.push('改动摘要：' + plan.summary)
  lines.push('改动点：')
  lines.push(bulletList(plan.changes.map(change => change.target + ' - ' + change.description), '由你根据摘要自行确定'))
  if (plan.writeScopes.length > 0) {
    lines.push('建议写范围（提示性前缀，非硬限制）：' + plan.writeScopes.join(', '))
  }
  if (plan.contractImpact.breaking.length > 0) {
    lines.push('注意：本仓计划包含破坏性契约变更，已被标记人审：')
    lines.push(bulletList(plan.contractImpact.breaking, ''))
  }
  lines.push('本仓验收标准：')
  lines.push(bulletList(plan.acceptance, '同全局验收标准'))
  lines.push('')
  if (upstreamResults.length > 0) {
    lines.push('## 已完成的上游仓库（可作为前提）')
    for (const upstream of upstreamResults) {
      lines.push('- ' + upstream.repo + (upstream.commit !== undefined ? '（commit ' + upstream.commit + '）' : '') + '：' + upstream.summary)
    }
    lines.push('')
  }
  lines.push('## 要求')
  lines.push('1. 只修改 ' + plan.repo + ' 仓库；不要动其他仓库。保持最小变更，只做计划内改动。')
  lines.push('2. 在仓库内完成修改后运行可用的测试或构建验证。')
  lines.push('3. 禁止安装任何依赖（npm/pnpm/yarn/pip/poetry/go get 等）；缺少依赖视为阻塞，在 summary 中说明。')
  lines.push('4. 测试无法本地执行时如实标记 needs_ci 并说明原因，严禁伪造测试结果。')
  if (input.noGit === true) {
    lines.push('5. 该目录不是独立的 git 仓库：直接修改文件即可，严禁执行任何 git 命令（add/commit/branch 等都会作用到外层仓库）。')
  } else if (selfCommit) {
    lines.push('5. 用 git 提交你的修改（信息用 conventional commits 风格）；不要 push，由调度方统一决定推送。')
  } else {
    lines.push('5. 不要执行任何 git commit / push；改完留在工作区即可，人工确认后由调度方提交。')
  }
  lines.push('6. 完成后按结构化输出报告：summary（改了什么）、commit（提交哈希，未提交则省略）、changedFiles（改动文件列表）。')
  lines.push('7. 如果无法完成（需求矛盾、缺少信息、上游未就绪），在 summary 中明确说明原因并停止，不要强行提交半成品。')
  return lines.join('\n')
}

/** Render one line of human-facing run narration for a tool result. */
export function renderRunLine(run: { perRepo: readonly { repo: string; state: string; commit?: string }[]; errors: readonly string[] }): string {
  const rows = run.perRepo.map(entry => {
    const commit = entry.commit !== undefined ? ' @ ' + entry.commit.slice(0, 7) : ''
    return entry.repo + ': ' + entry.state + commit
  })
  const suffix = run.errors.length > 0 ? '\n问题：\n' + bulletList(run.errors, '') : ''
  return rows.join('\n') + suffix
}
