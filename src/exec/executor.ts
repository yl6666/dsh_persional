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

import type { RepoModificationPlan, RepoRunRecord, RepoRunState, ExecutionRun, SubmitRequest } from '../pipeline/types.ts'
import { isProtectedBranch } from './git.ts'

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
  /** Requirement branch the executor has prepared (blank when none). */
  readonly branch: string
  /**
   * False when the path is not the root of its own git work tree: there is
   * no git state to protect, and any git command run at the path would
   * resolve UPWARD into an enclosing repository. Sessions must be told not
   * to touch git at all.
   */
  readonly isRepo?: boolean
  /** 1-based attempt number; a retry carries the failure history (17.3). */
  readonly attempt: number
  readonly previousErrors: readonly string[]
}

/** The injected per-repo worker (one DSH session per repo in production). */
export type RepoTask = (context: RepoTaskContext) => Promise<RepoTaskOutcome>;

/**
 * The git seam the executor needs for branch discipline and the submit gate
 * (16.1); satisfied structurally by GitClient, faked in tests.
 */
export interface RepoGitGateway {
  isRepo(cwd: string): Promise<boolean>
  checkoutBranch(cwd: string, branch: string): Promise<void>
  currentBranch(cwd: string): Promise<string>
  listChangedFiles(cwd: string): Promise<string[]>
  commitAll(cwd: string, message: string): Promise<string>
}

/** Options for one execution run. */
export interface ExecutePlansOptions {
  /** repo key -> local checkout path. */
  readonly repoPaths?: Readonly<Record<string, string>>
  /** Parallel cap within one readiness batch; default: whole batch. */
  readonly concurrency?: number
  /** Branch base; effective branch = plan.branch ?? base + '/' + plan.repo. */
  readonly branchBase?: string
  /** Who commits: the session itself (auto, default) or a human after the gate (manual). */
  readonly commitPolicy?: 'auto' | 'manual'
  /** Git operations for branch checkout and host-side commits; enables branch discipline. */
  readonly git?: RepoGitGateway
  /** Attempts per repo before giving up (17.3 loop cap); default 1. */
  readonly maxAttempts?: number
  /**
   * Failure history per repo from a previous run (re-dispatch, 17.3): seeds
   * previousErrors so the retry prompt carries what went wrong, and the
   * attempt counter continues where the previous run stopped.
   */
  readonly history?: Readonly<Record<string, readonly string[]>>
}

/** Effective requirement branch for one plan (6.2 branch rule). */
function branchOf(plan: RepoModificationPlan, base: string | undefined): string {
  if (plan.branch !== undefined && plan.branch !== '') return plan.branch
  return (base ?? 'ai-delivery') + '/' + plan.repo
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
  const extras = new Map<string, { commit?: string; diffSummary?: string; sessionId?: string; submitRequest?: SubmitRequest }>()
  const errors: string[] = []
  const executed = new Set<string>()
  const commitPolicy = options.commitPolicy ?? 'auto'
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1)

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

  /**
   * The submit gate (16.1). Auto policy trusts the session's own commit;
   * manual policy stops at a pending submit request - the host-side commit
   * happens only in the service, after a human approves. A path that is
   * not its own work tree root never enters the gate at all: git run there
   * resolves into the ENCLOSING repository, so listing changes or
   * committing would sweep up somebody else's checkout.
   */
  const settleSuccess = async (
    repo: string,
    plan: RepoModificationPlan,
    repoPath: string | undefined,
    isWorkTree: boolean,
  ): Promise<RepoRunState> => {
    if (!isWorkTree || options.git === undefined || repoPath === undefined || commitPolicy === 'auto') {
      return 'succeeded'
    }
    const changed = await options.git.listChangedFiles(repoPath)
    if (changed.length === 0) {
      // Nothing left to commit - the session's report stands as-is.
      return 'succeeded'
    }
    const branch = branchOf(plan, options.branchBase)
    extras.set(repo, {
      ...extras.get(repo),
      submitRequest: { branch, summary: plan.summary, changedFiles: changed },
    })
    return 'submit-pending'
  }

  const runOne = async (repo: string): Promise<void> => {
    if (stateByRepo.get(repo) !== 'pending') return
    stateByRepo.set(repo, 'running')
    const plan = byRepo.get(repo)!
    const repoPath = options.repoPaths?.[repo]
    let branch = branchOf(plan, options.branchBase)

    // Branch discipline (6.2): prepare the requirement branch before the
    // session touches the checkout; protected names never run. Paths that
    // are not the root of their own work tree get no discipline, no branch
    // claim, and no git instructions at all - any git command run at such a
    // path resolves into the enclosing repository (isRepo probe, 6.1).
    let isWorkTree = true
    if (options.git !== undefined && repoPath !== undefined) {
      try {
        isWorkTree = await options.git.isRepo(repoPath)
      } catch {
        isWorkTree = false
      }
      if (!isWorkTree) {
        branch = ''
      } else {
        if (isProtectedBranch(branch)) {
          stateByRepo.set(repo, 'needs-human')
          errors.push(repo + ': plan names protected branch ' + branch + ' - refusing to run')
          blockDependents(repo)
          return
        }
        try {
          await options.git.checkoutBranch(repoPath, branch)
        } catch (error) {
          stateByRepo.set(repo, 'needs-human')
          errors.push(repo + ': branch checkout failed: ' + (error instanceof Error ? error.message : String(error)))
          blockDependents(repo)
          return
        }
      }
    }

    // Re-dispatch (17.3): a repo's failure history from a previous run
    // seeds the retry context and continues the attempt counter.
    const seeded = [...(options.history?.[repo] ?? [])]
    const previousErrors: string[] = [...seeded]
    for (let attempt = 1 + seeded.length; ; attempt++) {
      let outcome: RepoTaskOutcome
      try {
        outcome = await task({ plan, repoPath, branch, isRepo: isWorkTree, attempt, previousErrors: [...previousErrors] })
      } catch (error) {
        outcome = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
      executed.add(repo)
      if (outcome.state === 'succeeded') {
        let nextState: RepoRunState
        try {
          nextState = await settleSuccess(repo, plan, repoPath, isWorkTree)
        } catch (error) {
          const message = 'commit gate failed: ' + (error instanceof Error ? error.message : String(error))
          stateByRepo.set(repo, 'needs-human')
          errors.push(repo + ': ' + message)
          blockDependents(repo)
          return
        }
        stateByRepo.set(repo, nextState)
        if (nextState === 'submit-pending') {
          errors.push(repo + ': waiting for human submit approval (branch ' + branch + ')')
        }
        extras.set(repo, {
          ...extras.get(repo),
          commit: extras.get(repo)?.commit ?? outcome.commit,
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
      if (outcome.state === 'failed' && attempt < maxAttempts) {
        // Defect loop (17.3): retry with the failure history in context.
        previousErrors.push(outcome.error)
        continue
      }
      if (outcome.state === 'failed') {
        stateByRepo.set(repo, 'failed')
        errors.push(repo + (previousErrors.length > 0 ? ' (after ' + (attempt) + ' attempts): ' : ': ') + outcome.error)
      } else {
        stateByRepo.set(repo, 'needs-human')
        errors.push(repo + ': ' + outcome.reason)
      }
      blockDependents(repo)
      return
    }
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
      submitRequest: extra?.submitRequest,
    }
  })
  return { perRepo, errors }
}
