import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { GitClient, NodeCommandRunner, isProtectedBranch } from '../src/exec/git.ts'
import type { CommandRunner, RunResult } from '../src/exec/git.ts'

function fakeRunner(script: Record<string, RunResult>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async run(command, args, cwd) {
      calls.push([command, ...args, '@' + cwd])
      const key = args.join(' ')
      const hit = script[key]
      if (hit === undefined) return { stdout: '', stderr: 'not scripted: ' + key, exitCode: 1 }
      return hit
    },
  }
}

describe('GitClient parsing and arguments (fake runner)', () => {
  it('parses porcelain status with branch tracking info', async () => {
    const runner = fakeRunner({
      'status --porcelain=v1 --branch --untracked-files=all': {
        stdout: [
          '## main...origin/main [ahead 1, behind 2]',
          ' M src/a.ts',
          '?? new.txt',
          'A  staged.txt',
          'MM both.txt',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
    const client = new GitClient(runner)
    const status = await client.status('D:/x')
    expect(status).toEqual({
      branch: 'main',
      ahead: 1,
      behind: 2,
      staged: ['staged.txt', 'both.txt'],
      modified: ['src/a.ts', 'both.txt'],
      untracked: ['new.txt'],
      clean: false,
    })
  })

  it('parses a plain branch header and reports clean', async () => {
    const runner = fakeRunner({
      'status --porcelain=v1 --branch --untracked-files=all': { stdout: '## feature/x', stderr: '', exitCode: 0 },
    })
    const status = await new GitClient(runner).status('D:/x')
    expect(status.branch).toBe('feature/x')
    expect(status.clean).toBe(true)
  })

  it('commitAll stages everything, commits with identity overrides, returns the hash', async () => {
    const runner = fakeRunner({
      'status --porcelain=v1 --branch --untracked-files=all': { stdout: '## feature/wip\n', stderr: '', exitCode: 0 },
      'add -A': { stdout: '', stderr: '', exitCode: 0 },
      '-c user.name=board -c user.email=b@x commit -m msg': { stdout: '[feature/wip abc1234] msg', stderr: '', exitCode: 0 },
      'rev-parse HEAD': { stdout: 'abc1234def5678\n', stderr: '', exitCode: 0 },
    })
    const client = new GitClient(runner, { name: 'board', email: 'b@x' })
    await expect(client.commitAll('D:/x', 'msg')).resolves.toBe('abc1234def5678')
    expect(runner.calls.map(call => call.slice(0, -1))).toContainEqual(['git', 'add', '-A'])
    expect(runner.calls.map(call => call.slice(0, -1))).toContainEqual([
      'git', '-c', 'user.name=board', '-c', 'user.email=b@x', 'commit', '-m', 'msg',
    ])
  })

  it('commitAll refuses protected branches (branch discipline)', async () => {
    const runner = fakeRunner({
      'status --porcelain=v1 --branch --untracked-files=all': { stdout: '## main\n', stderr: '', exitCode: 0 },
    })
    const client = new GitClient(runner)
    await expect(client.commitAll('D:/x', 'msg')).rejects.toThrow(/protected branch main/)
    expect(runner.calls.map(call => call.slice(0, -1))).not.toContainEqual(['git', 'add', '-A'])
  })

  it('commitAll survives an unborn HEAD via the porcelain header', async () => {
    const runner = fakeRunner({
      'status --porcelain=v1 --branch --untracked-files=all': {
        stdout: '## No commits yet on ai-delivery/req-1\n?? a.txt\n', stderr: '', exitCode: 0,
      },
      'add -A': { stdout: '', stderr: '', exitCode: 0 },
      '-c user.name=board -c user.email=b@x commit -m msg': { stdout: '', stderr: '', exitCode: 0 },
      'rev-parse HEAD': { stdout: 'abc1234def5678\n', stderr: '', exitCode: 0 },
    })
    const client = new GitClient(runner, { name: 'board', email: 'b@x' })
    await expect(client.commitAll('D:/x', 'msg')).resolves.toBe('abc1234def5678')
  })

  it('checkoutBranch creates-or-resets a non-protected branch', async () => {
    const runner = fakeRunner({ 'checkout -B ai-delivery/req-1': { stdout: '', stderr: '', exitCode: 0 } })
    const client = new GitClient(runner)
    await expect(client.checkoutBranch('D:/x', 'ai-delivery/req-1')).resolves.toBeUndefined()
    expect(runner.calls.map(call => call.slice(0, -1))).toContainEqual([
      'git', 'checkout', '-B', 'ai-delivery/req-1',
    ])
  })

  it('isProtectedBranch matches trunks and release branches only', () => {
    for (const protected_ of ['main', 'master', 'develop', 'release', 'release/1.2', 'HEAD', '']) {
      expect(isProtectedBranch(protected_)).toBe(true)
    }
    for (const open of ['ai-delivery/req-1', 'feature/x', 'bugfix/y', 'trunkish']) {
      expect(isProtectedBranch(open)).toBe(false)
    }
  })

  it('isRepo requires the directory to be its work tree root, not just inside one', async () => {
    const toplevel = { stdout: 'D:/x\n', stderr: '', exitCode: 0 }
    const root = fakeRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n', stderr: '', exitCode: 0 },
      '-c core.quotepath=off rev-parse --show-toplevel': toplevel,
    })
    const subdir = fakeRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n', stderr: '', exitCode: 0 },
      '-c core.quotepath=off rev-parse --show-toplevel': { stdout: 'D:/parent\n', stderr: '', exitCode: 0 },
    })
    const outside = fakeRunner({ 'rev-parse --is-inside-work-tree': { stdout: 'false\n', stderr: '', exitCode: 0 } })
    // Path spelling (case, slashes) must not matter on Windows.
    expect(await new GitClient(root).isRepo('d:\\x')).toBe(true)
    expect(await new GitClient(subdir).isRepo('D:/x')).toBe(false)
    expect(await new GitClient(outside).isRepo('D:/x')).toBe(false)
  })
})

describe('GitClient against a real git checkout', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it('init -> checkout -> status -> commitAll -> clean status round trip', async () => {
    const runner = new NodeCommandRunner()
    const client = new GitClient(runner)
    const dir = await mkdtemp(join(tmpdir(), 'repo-board-git-'))
    dirs.push(dir)
    expect((await runner.run('git', ['init'], dir)).exitCode).toBe(0)

    // Branch discipline: AI commits land on a requirement branch, never the trunk.
    await client.checkoutBranch(dir, 'ai-delivery/test-1')
    expect(await client.currentBranch(dir)).toBe('ai-delivery/test-1')

    expect(await client.isRepo(dir)).toBe(true)
    expect((await client.status(dir)).clean).toBe(true)

    await writeFile(join(dir, 'src.txt'), 'hello\n', 'utf8')
    let status = await client.status(dir)
    expect(status.untracked).toEqual(['src.txt'])
    expect(status.clean).toBe(false)

    const hash = await client.commitAll(dir, 'feat: first commit')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)

    status = await client.status(dir)
    expect(status.clean).toBe(true)
    expect(status.branch).toBe('ai-delivery/test-1')

    // A second checkout -B resets to the same line of work, still not the trunk.
    await client.checkoutBranch(dir, 'ai-delivery/test-2')
    expect(await client.currentBranch(dir)).toBe('ai-delivery/test-2')

    await writeFile(join(dir, 'src.txt'), 'hello again\n', 'utf8')
    expect(await client.listChangedFiles(dir)).toEqual(['src.txt'])
  })

  it('listChangedFiles counts untracked files on a born HEAD - they are what commitAll would commit', async () => {
    const runner = new NodeCommandRunner()
    const client = new GitClient(runner)
    const dir = await mkdtemp(join(tmpdir(), 'repo-board-untracked-'))
    dirs.push(dir)
    expect((await runner.run('git', ['init'], dir)).exitCode).toBe(0)
    await writeFile(join(dir, 'base.txt'), 'base\n', 'utf8')
    expect((await runner.run('git', ['add', '-A'], dir)).exitCode).toBe(0)
    expect((await runner.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'init'], dir)).exitCode).toBe(0)

    // Only NEW files, no tracked modification: `git diff --name-only HEAD`
    // returns empty here, and this call must not (submit-gate regression).
    await writeFile(join(dir, 'new-module.ts'), 'export const x = 1\n', 'utf8')
    expect(await client.listChangedFiles(dir)).toEqual(['new-module.ts'])

    // Mixed: the modified file AND the new one both count.
    await writeFile(join(dir, 'base.txt'), 'changed\n', 'utf8')
    expect(await client.listChangedFiles(dir)).toEqual(['base.txt', 'new-module.ts'])
  })

  it('isRepo is false for a plain subdirectory of a larger work tree', async () => {
    const runner = new NodeCommandRunner()
    const client = new GitClient(runner)
    const dir = await mkdtemp(join(tmpdir(), 'repo-board-subdir-'))
    dirs.push(dir)
    expect((await runner.run('git', ['init'], dir)).exitCode).toBe(0)
    await writeFile(join(dir, 'base.txt'), 'base\n', 'utf8')
    expect((await runner.run('git', ['add', '-A'], dir)).exitCode).toBe(0)
    expect((await runner.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'init'], dir)).exitCode).toBe(0)

    // The subdirectory sits INSIDE the parent's work tree, so
    // --is-inside-work-tree answers true there - but treating it as a repo
    // would run checkout -B on the ENCLOSING checkout. Only the root is a
    // repo (hijack regression: this once switched the plugin's own repo).
    await mkdir(join(dir, 'packages', 'inner'), { recursive: true })
    expect(await client.isRepo(join(dir, 'packages', 'inner'))).toBe(false)
    expect(await client.isRepo(dir)).toBe(true)
  })

  it.runIf(process.platform === 'win32')(
    'isRepo follows junction and 8.3 short-name spellings of the same root',
    async () => {
      const { execFileSync } = await import('node:child_process')
      const runner = new NodeCommandRunner()
      const client = new GitClient(runner)
      const dir = await mkdtemp(join(tmpdir(), 'repo-board-junction-'))
      dirs.push(dir)
      const physical = join(dir, 'svc-repo')
      await mkdir(physical, { recursive: true })
      await writeFile(join(physical, 'base.txt'), 'base\n', 'utf8')
      expect((await runner.run('git', ['init', '-b', 'main'], physical)).exitCode).toBe(0)
      expect((await runner.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'add', '-A'], physical)).exitCode).toBe(0)
      expect((await runner.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'init'], physical)).exitCode).toBe(0)

      // A junction is the same checkout under a different spelling; before
      // the realpath fix --show-toplevel answered with the physical path and
      // the junction-spelled root silently lost branch discipline.
      const junction = join(dir, 'svc-link')
      execFileSync('cmd', ['/c', 'mklink', '/J', junction, physical])
      expect(await client.isRepo(physical)).toBe(true)
      expect(await client.isRepo(junction)).toBe(true)
    },
  )

  it('isRepo survives a non-ASCII repository root', async () => {
    const runner = new NodeCommandRunner()
    const client = new GitClient(runner)
    const dir = await mkdtemp(join(tmpdir(), 'repo-board-'))
    dirs.push(dir)
    const repo = join(dir, '仓库目录')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
    expect((await runner.run('git', ['init', '-b', 'main'], repo)).exitCode).toBe(0)
    // Without core.quotepath=off the toplevel can come back C-quoted and
    // the comparison silently fails (discipline skipped).
    expect(await client.isRepo(repo)).toBe(true)
  })
})
