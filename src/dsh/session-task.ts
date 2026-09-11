/**
 * The RepoTask binding that runs one DSH subagent session per repo
 * (docs/product-design.md 6, 12 - subagents first).
 *
 * Each repo plan becomes one one-shot subagent with a structured-output
 * schema; the session works inside the repo checkout and commits. The
 * binding maps the subagent outcome onto the executor's RepoTaskOutcome.
 * @module dsh-repo-board
 */

import type { RepoTask, RepoTaskOutcome } from '../exec/executor.ts'
import type { RepoModificationPlan, RequirementSpec } from '../pipeline/types.ts'
import type { ContentBlock, SubagentsRuntimeLike } from './types.ts'
import { buildRepoSessionPrompt, repoSessionOutputSchema } from './prompt.ts'
import type { RepoSessionOutput } from './prompt.ts'

/** Result summaries of already-finished upstream repo sessions. */
export interface UpstreamResult {
  readonly repo: string
  readonly summary: string
  readonly commit?: string
}

/** Options for {@link buildRepoSessionTask}. */
export interface RepoSessionTaskOptions {
  readonly subagents: SubagentsRuntimeLike
  readonly parent: object
  readonly spec: RequirementSpec
  /** Collects finished upstream results so later repos can build on them. */
  readonly upstream: { results: UpstreamResult[] }
  readonly signal: AbortSignal
  /** False when the host commits after human approval; the session must not commit. */
  readonly selfCommit?: boolean
}

function isRepoSessionOutput(value: unknown): value is RepoSessionOutput {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { summary?: unknown; changedFiles?: unknown; commit?: unknown }
  if (typeof candidate.summary !== 'string' || candidate.summary === '') return false
  if (!Array.isArray(candidate.changedFiles)) return false
  if (candidate.commit !== undefined && typeof candidate.commit !== 'string') return false
  return true
}

/**
 * Build the per-repo task that spawns one subagent session per plan. The
 * label and prompt derive purely from the plan; upstream results flow into
 * later prompts through the shared collector.
 */
export function buildRepoSessionTask(options: RepoSessionTaskOptions): RepoTask {
  return async ({ plan, repoPath, branch, attempt, previousErrors }): Promise<RepoTaskOutcome> => {
    const prompt = buildRepoSessionPrompt({
      plan,
      spec: options.spec,
      repoPath,
      branch,
      attempt,
      previousErrors,
      selfCommit: options.selfCommit,
      upstreamResults: options.upstream.results.filter(result => plan.prerequisites.includes(result.repo)),
    })
    const run = await options.subagents.start({
      label: 'repo-board/' + plan.repo,
      prompt: [{ type: 'text', text: prompt }] satisfies ContentBlock[],
      parent: options.parent,
      signal: options.signal,
      outputSchema: repoSessionOutputSchema,
    })
    const result = await run.result
    const sessionId = String((run as { id?: unknown }).id ?? '')
    if (isRepoSessionOutput(result.structured)) {
      const output = result.structured
      options.upstream.results.push({ repo: plan.repo, summary: output.summary, commit: output.commit })
      return {
        state: 'succeeded',
        sessionId,
        commit: output.commit,
        diffSummary: output.changedFiles.join(', '),
      }
    }
    const text = result.output
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    return {
      state: 'failed',
      sessionId,
      error: 'repo session ended without structured output (stopReason: ' + result.stopReason + ')' + (text === '' ? '' : ': ' + text.slice(0, 500)),
    }
  }
}
