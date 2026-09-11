/**
 * Behavior tests for the daemon's git operations, run against real `git`
 * repositories built in a fresh temporary directory per test.
 *
 * @module dsh-remote-agent/tests/git
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { GitBackend } from '../src/git.ts'
import { GitFailure, createGitBackend } from '../src/git.ts'

/** Committer identity for fixture commits. */
const IDENTITY: readonly string[] = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test']

/** Run git in a fixture directory and return its stdout. */
async function gitIn(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error === null) resolve(stdout)
      else reject(error)
    })
  })
}

/** Stage everything and commit it with the fixture identity. */
async function commit(cwd: string, message: string): Promise<void> {
  await gitIn(cwd, ['add', '.'])
  await gitIn(cwd, [...IDENTITY, 'commit', '-q', '-m', message])
}

/** Run an operation expected to fail and return its typed failure. */
async function captureFailure(run: () => Promise<unknown>): Promise<GitFailure> {
  try {
    await run()
  } catch (error: unknown) {
    assert.ok(error instanceof GitFailure, `expected GitFailure, got ${String(error)}`)
    return error
  }
  throw new Error('expected the operation to fail')
}

/** Run an operation expected to fail and return its protocol code. */
async function failureCode(run: () => Promise<unknown>): Promise<string> {
  return (await captureFailure(run)).code
}

describe('git backend', () => {
  let root: string
  let repo: string
  let baseBranch: string
  let git: GitBackend

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-git-'))
    repo = join(root, 'repo')
    await mkdir(repo)
    await gitIn(repo, ['init', '-q'])
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await commit(repo, 'base')
    baseBranch = (await gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    git = createGitBackend(undefined)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('adds, lists, and removes a worktree', async () => {
    const worktreePath = join(root, 'feature-wt')
    const created = await git.worktreeAdd(repo, worktreePath, 'feature', undefined)
    assert.equal(created.path, worktreePath)
    assert.equal(created.branch, 'feature')
    assert.equal(created.main, false)
    assert.match(created.head, /^[0-9a-f]{40,64}$/)

    const listed = await git.worktreeList(repo)
    assert.equal(listed.length, 2)
    assert.equal(listed[0]?.main, true)
    assert.equal(listed[0]?.branch, baseBranch)
    assert.equal(listed[1]?.main, false)
    assert.equal(listed[1]?.branch, 'feature')
    const feature = listed[1]
    assert.ok(feature !== undefined)
    assert.equal(await realpath(feature.path), await realpath(worktreePath))
    assert.equal(feature.head, created.head)

    await git.worktreeRemove(repo, worktreePath, false)
    assert.equal((await git.worktreeList(repo)).length, 1)
  })

  it('refuses a worktree path that already exists', async () => {
    const worktreePath = join(root, 'duplicate-wt')
    await git.worktreeAdd(repo, worktreePath, 'taken-path', undefined)
    assert.equal(
      await failureCode(() => git.worktreeAdd(repo, worktreePath, 'other', undefined)),
      'GIT_WORKTREE_EXISTS',
    )
  })

  it('refuses a branch name that already exists', async () => {
    await git.worktreeAdd(repo, join(root, 'taken-branch-wt'), 'taken', undefined)
    assert.equal(
      await failureCode(() => git.worktreeAdd(repo, join(root, 'fresh-wt'), 'taken', undefined)),
      'GIT_BRANCH_EXISTS',
    )
  })

  it('refuses to remove a dirty worktree without force', async () => {
    const worktreePath = join(root, 'dirty-wt')
    await git.worktreeAdd(repo, worktreePath, 'dirty', undefined)
    await writeFile(join(worktreePath, 'scratch.txt'), 'uncommitted\n')

    assert.equal(await failureCode(() => git.worktreeRemove(repo, worktreePath, false)), 'GIT_DIRTY')
    await git.worktreeRemove(repo, worktreePath, true)
    assert.equal((await git.worktreeList(repo)).length, 1)
  })

  it('refuses to delete an unmerged branch without force', async () => {
    await gitIn(repo, ['checkout', '-q', '-b', 'topic'])
    await writeFile(join(repo, 'topic.txt'), 'topic\n')
    await commit(repo, 'topic')
    await gitIn(repo, ['checkout', '-q', baseBranch])

    assert.equal(await failureCode(() => git.branchDelete(repo, 'topic', false)), 'GIT_DIRTY')
    assert.deepEqual(await git.branchDelete(repo, 'topic', true), {})
    assert.equal((await gitIn(repo, ['branch', '--list', 'topic'])).trim(), '')
  })

  it('reports the branch and whether the tree is clean', async () => {
    assert.deepEqual(await git.repoState(repo), { branch: baseBranch, clean: true })

    await writeFile(join(repo, 'untracked.txt'), 'x\n')
    assert.deepEqual(await git.repoState(repo), { branch: baseBranch, clean: false })
    await rm(join(repo, 'untracked.txt'))

    await writeFile(join(repo, 'file.txt'), 'changed\n')
    assert.deepEqual(await git.repoState(repo), { branch: baseBranch, clean: false })
  })

  it('merges a branch and then reports it already merged', async () => {
    await gitIn(repo, ['checkout', '-q', '-b', 'feature'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await commit(repo, 'feature')
    await gitIn(repo, ['checkout', '-q', baseBranch])

    const merged = await git.mergeBranch(repo, 'feature')
    assert.equal(merged.alreadyMerged, false)
    assert.match(merged.head, /^[0-9a-f]{40,64}$/)
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature\n')

    const again = await git.mergeBranch(repo, 'feature')
    assert.equal(again.alreadyMerged, true)
    assert.equal(again.head, merged.head)
  })

  it('aborts a conflicted merge, names the paths, and leaves the tree clean', async () => {
    await gitIn(repo, ['checkout', '-q', '-b', 'conflict'])
    await writeFile(join(repo, 'file.txt'), 'feature side\n')
    await commit(repo, 'feature side')
    await gitIn(repo, ['checkout', '-q', baseBranch])
    await writeFile(join(repo, 'file.txt'), 'base side\n')
    await commit(repo, 'base side')

    const failure = await captureFailure(() => git.mergeBranch(repo, 'conflict'))
    assert.equal(failure.code, 'GIT_DIRTY')
    assert.match(failure.message, /file\.txt/)

    assert.equal((await gitIn(repo, ['status', '--porcelain'])).trim(), '')
    assert.equal((await git.repoState(repo)).clean, true)
    const mergeHead = await gitIn(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
      .then(() => true, () => false)
    assert.equal(mergeHead, false)
  })

  it('refuses a path outside any repository', async () => {
    assert.equal(
      await failureCode(() => git.worktreeList(join(root, 'not-a-repo'))),
      'GIT_NOT_A_REPOSITORY',
    )
  })

  it('reports an unknown base revision as a missing ref', async () => {
    assert.equal(
      await failureCode(() => git.worktreeAdd(repo, join(root, 'bad-base-wt'), 'bad-base', 'no-such-ref')),
      'GIT_REF_NOT_FOUND',
    )
    assert.equal(
      await failureCode(() => git.mergeBranch(repo, 'no-such-branch')),
      'GIT_REF_NOT_FOUND',
    )
  })
})
