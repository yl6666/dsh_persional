/**
 * Git wrapper - the only module that talks to the git binary
 * (docs/product-design.md 6, 14.5).
 *
 * All shell-outs go through an injectable {@link CommandRunner} seam so tests
 * drive a fake and the production runner stays a thin child_process wrapper.
 * Commits carry per-invocation identity overrides so the executor works on
 * machines without a global git identity.
 * @module dsh-repo-board
 */

/** One finished process run. */
export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Injectable process runner: executes a command in a working directory. */
export interface CommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<RunResult>
}

/** Status slices we care about for one repo checkout. */
export interface GitStatus {
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly staged: readonly string[]
  readonly modified: readonly string[]
  readonly untracked: readonly string[]
  readonly clean: boolean
}

/** Commit identity used for -c overrides. */
export interface GitIdentity {
  readonly name: string
  readonly email: string
}

function lines(output: string): string[] {
  return output.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line !== '')
}

function parseStatus(stdout: string): GitStatus {
  let branch = ''
  let ahead = 0
  let behind = 0
  const staged: string[] = []
  const modified: string[] = []
  const untracked: string[] = []
  for (const raw of lines(stdout)) {
    if (raw.startsWith('## ')) {
      let head = raw.slice(3)
      // An unborn HEAD reports `## No commits yet on <branch>`; strip the
      // prefix so the branch name parses the same as a born checkout.
      if (head.startsWith('No commits yet on ')) head = head.slice('No commits yet on '.length)
      branch = (head.split(/\s+/)[0] ?? head).split('...')[0]!
      const aheadMatch = /\bahead (\d+)/.exec(head)
      const behindMatch = /\bbehind (\d+)/.exec(head)
      ahead = aheadMatch === null ? 0 : Number(aheadMatch[1])
      behind = behindMatch === null ? 0 : Number(behindMatch[1])
      continue
    }
    if (raw.length < 4) continue
    const code = raw.slice(0, 2)
    const path = raw.slice(3).trim()
    if (code === '??') untracked.push(path)
    else {
      if (code[0] !== ' ') staged.push(path)
      if (code[1] !== ' ') modified.push(path)
    }
  }
  const clean = staged.length === 0 && modified.length === 0 && untracked.length === 0
  return { branch, ahead, behind, staged, modified, untracked, clean }
}

/** Branches AI changes must never land on directly (6.2 branch rule). */
const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'HEAD']

/** True when `branch` is a protected trunk branch no AI change may touch. */
export function isProtectedBranch(branch: string): boolean {
  const name = branch.trim()
  if (name === '') return true
  if (PROTECTED_BRANCHES.includes(name)) return true
  return name === 'release' || name.startsWith('release/')
}

/** Git operations for one host, against any number of checkouts. */
export class GitClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly identity: GitIdentity = { name: 'dsh-repo-board', email: 'repo-board@dsh.invalid' },
  ) {}

  private async git(args: readonly string[], cwd: string): Promise<RunResult> {
    return this.runner.run('git', args, cwd)
  }

  private async require(args: readonly string[], cwd: string): Promise<string> {
    const result = await this.git(args, cwd)
    if (result.exitCode !== 0) {
      throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + (result.stderr || result.stdout).trim())
    }
    return result.stdout
  }

  /** True when `cwd` sits inside a git work tree. */
  async isRepo(cwd: string): Promise<boolean> {
    const result = await this.git(['rev-parse', '--is-inside-work-tree'], cwd)
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  }

  /** Current branch name; symbolic-ref works on an unborn HEAD too. */
  async currentBranch(cwd: string): Promise<string> {
    const result = await this.git(['symbolic-ref', '--short', 'HEAD'], cwd)
    if (result.exitCode === 0) return result.stdout.trim()
    // Detached HEAD: symbolic-ref refuses; report it as such.
    return 'HEAD'
  }

  /** Porcelain status summary (untracked files fully expanded, no dir folding). */
  async status(cwd: string): Promise<GitStatus> {
    return parseStatus(
      await this.require(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], cwd),
    )
  }

  /** Files changed vs `base` (or vs HEAD for staged+worktree changes). */
  async listChangedFiles(cwd: string, base?: string): Promise<string[]> {
    const result = await this.git(
      base === undefined ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', base],
      cwd,
    )
    if (result.exitCode === 0) return lines(result.stdout)
    // Unborn HEAD (a fresh checkout with no commits yet): everything staged,
    // modified, or untracked counts as changed.
    const status = await this.status(cwd)
    return [...status.staged, ...status.modified, ...status.untracked]
  }

  /** Stage everything and commit with the board identity. Returns the new hash. */
  async commitAll(cwd: string, message: string): Promise<string> {
    // Branch discipline (6.2): porcelain status, because rev-parse based
    // branch lookup fails on an unborn HEAD.
    const { branch } = await this.status(cwd)
    if (isProtectedBranch(branch)) {
      throw new Error('refusing to commit on protected branch ' + branch + ' in ' + cwd)
    }
    await this.require(['add', '-A'], cwd)
    await this.require(
      [
        '-c', 'user.name=' + this.identity.name,
        '-c', 'user.email=' + this.identity.email,
        'commit', '-m', message,
      ],
      cwd,
    )
    return (await this.require(['rev-parse', 'HEAD'], cwd)).trim()
  }

  /** Create-or-reset `branch` and check it out; refuses protected names (6.2). */
  async checkoutBranch(cwd: string, branch: string): Promise<void> {
    if (isProtectedBranch(branch)) {
      throw new Error('refusing to check out protected branch ' + branch + ' in ' + cwd)
    }
    await this.require(['checkout', '-B', branch], cwd)
  }

  /** Push the current branch to its upstream (or `origin HEAD` when unset). */
  async push(cwd: string, branch?: string): Promise<void> {
    const target = branch ?? (await this.currentBranch(cwd))
    await this.require(['push', 'origin', target], cwd)
  }

  /** Clone `url` into `dir`; returns nothing on success. */
  async clone(url: string, dir: string): Promise<void> {
    const result = await this.git(['clone', url, dir], process.cwd())
    if (result.exitCode !== 0) {
      throw new Error('git clone ' + url + ' failed: ' + (result.stderr || result.stdout).trim())
    }
  }
}

/** Production runner over node:child_process. Spawns are inherit-stdio free. */
export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
    const { spawn } = await import('node:child_process')
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', exitCode => { resolve({ stdout, stderr, exitCode: exitCode ?? 1 }) })
    })
  }
}
