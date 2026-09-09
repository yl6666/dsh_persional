/**
 * Topological plan executor - steps [5]-[6] of the dispatch pipeline
 * (docs/product-design.md 6, 13.3).
 *
 * Schedules one task per repo plan, upstream first: a repo runs only after
 * all its plan prerequisites succeeded. Repos in the same readiness batch
 * run in parallel under an optional concurrency cap. A failure or
 * needs-human outcome blocks every transitive dependent instead of running
 * it half-cocked; prerequisite cycles are surfaced for human review rather
 * than deadlocking. The task itself is injected - the DSH binding runs one
 * session per repo (6), tests run fakes.
 * @module dsh-repo-board
 */

import type { RepoModificationPlan, RepoRunRecord, RepoRunState, ExecutionRun } from '../pipeline/types.ts'

/** What one repo task may report back. */
export type RepoTaskOutcome =
  | { state: 'succeeded'; commit?: string; diffSummary?: string; sessionId?: string }
  | { state: 'failed'; error: string; sessionId?: string }
  | { state: 'needs-human'; reason: string; sessionId?: string }

/** Context handed to one repo task. */
export interface RepoTaskContext {
  readonly plan: RepoModificationPlan
  /** Local checkout path when known from the graph. */
  readonly repoPath?: string
}

/** The injected per-repo worker (one DSH session per repo in production). */
export type RepoTask = (context: RepoTaskContext) => Promise<RepoTaskOutcome>;

/** Options for one execution run. */
export interface ExecutePlansOptions {
  /** repo key -> local checkout path. */
  readonly repoPaths?: Readonly<Record<string, string>>
  /** Parallel cap within one readiness batch; default: whole batch. */
  readonly concurrency?: number
}

/**
 * Execute a plan set in dependency order and assemble the ExecutionRun.
 * Never throws for task failures - they land in the run's errors and block
 * dependents.
 */
export async function executePlans(
  plans: readonly RepoModificationPlan[],
  task: RepoTask,
  options: ExecutePlansOptions = {},
): Promise<ExecutionRun> {
  const byRepo = new Map(plans.map(plan => [plan.repo, plan]))
  const planned = new Set(byRepo.keys())

  const remainingPrereqs = new Map<string, number>()
  const dependents = new Map<string, Set<string>>()
  for (const plan of plans) {
    const prerequisites = plan.prerequisites.filter(prerequisite => planned.has(prerequisite))
    remainingPrereqs.set(plan.repo, prerequisites.length)
    for (const prerequisite of prerequisites) {
      let set = dependents.get(prerequisite)
      if (set === undefined) {
        set = new Set<string>()
        dependents.set(prerequisite, set)
      }
      set.add(plan.repo)
    }
  }

  const stateByRepo = new Map<string, RepoRunState>(plans.map(plan => [plan.repo, 'pending' as RepoRunState]))
  const extras = new Map<string, { commit?: string; diffSummary?: string; sessionId?: string }>()
  const errors: string[] = []
  const executed = new Set<string>()

  const blockDependents = (repo: string): void => {
    const stack = [...(dependents.get(repo) ?? [])]
    while (stack.length > 0) {
      const dependent = stack.pop()!
      if (stateByRepo.get(dependent) !== 'pending') continue
      stateByRepo.set(dependent, 'needs-human')
      errors.push(dependent + ': blocked by upstream ' + repo)
      stack.push(...(dependents.get(dependent) ?? []))
    }
  }

  const runOne = async (repo: string): Promise<void> => {
    if (stateByRepo.get(repo) !== 'pending') return
    stateByRepo.set(repo, 'running')
    const plan = byRepo.get(repo)!
    let outcome: RepoTaskOutcome
    try {
      outcome = await task({ plan, repoPath: options.repoPaths?.[repo] })
    } catch (error) {
      outcome = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    executed.add(repo)
    if (outcome.state === 'succeeded') {
      stateByRepo.set(repo, 'succeeded')
      extras.set(repo, {
        commit: outcome.commit,
        diffSummary: outcome.diffSummary,
        sessionId: outcome.sessionId,
      })
      for (const dependent of dependents.get(repo) ?? []) {
        const left = (remainingPrereqs.get(dependent) ?? 0) - 1
        remainingPrereqs.set(dependent, left)
        if (left === 0 && stateByRepo.get(dependent) === 'pending') ready.push(dependent)
      }
      return
    }
    if (outcome.state === 'failed') {
      stateByRepo.set(repo, 'failed')
      errors.push(repo + ': ' + outcome.error)
    } else {
      stateByRepo.set(repo, 'needs-human')
      errors.push(repo + ': ' + outcome.reason)
    }
    blockDependents(repo)
  }

  let ready: string[] = plans
    .filter(plan => (remainingPrereqs.get(plan.repo) ?? 0) === 0)
    .map(plan => plan.repo)

  while (ready.length > 0) {
    const batch = [...ready]
    ready = []
    const cap = options.concurrency ?? batch.length
    const queue = [...batch]
    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(cap, batch.length); i++) {
      workers.push(
        (async () => {
          for (;;) {
            const repo = queue.shift()
            if (repo === undefined) return
            await runOne(repo)
          }
        })(),
      )
    }
    await Promise.all(workers)
  }

  const stalled = plans.filter(plan => !executed.has(plan.repo) && stateByRepo.get(plan.repo) === 'pending')
  if (stalled.length > 0) {
    errors.push(
      'prerequisite cycle among: ' + stalled.map(plan => plan.repo).sort().join(', ') + ' - needs human review',
    )
    for (const plan of stalled) stateByRepo.set(plan.repo, 'needs-human')
  }

  const perRepo: RepoRunRecord[] = plans.map(plan => {
    const extra = extras.get(plan.repo)
    return {
      repo: plan.repo,
      state: stateByRepo.get(plan.repo) ?? 'pending',
      sessionId: extra?.sessionId,
      commit: extra?.commit,
      diffSummary: extra?.diffSummary,
    }
  })
  return { perRepo, errors }
}
