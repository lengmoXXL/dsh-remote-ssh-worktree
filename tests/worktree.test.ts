/**
 * The lifecycle is where a remote checkout and a local anchor have to stay in
 * step, so its cases are about ordering and partial failure: an anchor is never
 * recorded for a checkout that failed, never kept for one that is gone, and a
 * branch that outlives its checkout is reported rather than hidden.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnchorStore } from '../src/anchors/store.ts'
import type { AnchorStore } from '../src/anchors/store.ts'
import type { NodeChannel } from '../src/node/channel.ts'
import { NodeRequestError } from '../src/node/channel.ts'
import { createWorktreeManager } from '../src/worktree/manager.ts'
import type { WorktreeManager } from '../src/worktree/manager.ts'
import { asNodeId } from '../src/ids.ts'
import { asAnchorId } from '../src/ids.ts'

let root: string
let anchors: AnchorStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drw-worktree-'))
  anchors = createAnchorStore({ root })
  await anchors.load()
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A channel recording every call and answering from a script. */
function stubChannel(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request(method, params) {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer instanceof Error) return Promise.reject(answer)
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${method}`)) as never
      return Promise.resolve(answer) as never
    },
  }
  return { channel, calls }
}

/** A manager over one stub channel, plus the calls it recorded. */
function managerWith(answers: Record<string, unknown>, nodeId = 'n1'): { manager: WorktreeManager; calls: { method: string; params: unknown }[] } {
  // `create` also makes the managed directory invisible to git, so every
  // script answers that call unless a case overrides it.
  const { channel, calls } = stubChannel({ 'fs.writeText': {}, ...answers })
  return {
    manager: createWorktreeManager({ anchors, channel: id => (id === nodeId ? channel : undefined) }),
    calls,
  }
}

const draft = { nodeId: asNodeId('n1'), repoPath: '/srv/app', name: 'login' }

test('create cuts the checkout and records an anchor at the reported path', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })

  const anchor = await manager.create(draft)

  assert.deepEqual(calls, [
    {
      method: 'git.worktreeAdd',
      params: {
        repoPath: '/srv/app',
        worktreePath: '/srv/app/.dsh-worktrees/worktree/login',
        branch: 'worktree/login',
      },
    },
    {
      method: 'fs.writeText',
      params: {
        path: '/srv/app/.dsh-worktrees/.gitignore',
        content: '*\n',
        expected: { kind: 'createIfAbsent' },
      },
    },
  ])
  assert.equal(anchor.remoteRoot, '/srv/app/.dsh-worktrees/worktree/login')
  assert.equal(anchor.branch, 'worktree/login')
  assert.equal(anchors.list().length, 1)
})

test('an explicit base revision travels to git', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create({ ...draft, baseRef: 'origin/main' })
  assert.equal((calls[0]?.params as { baseRef?: string }).baseRef, 'origin/main')
})

test('the path the daemon reported wins over the computed one', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  assert.equal(anchor.remoteRoot, '/elsewhere/login')
})

test('a refused add records no anchor', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': new NodeRequestError({ code: 'GIT_WORKTREE_EXISTS', message: 'already there' }),
  })

  await assert.rejects(() => manager.create(draft), /already there/)
  assert.deepEqual(anchors.list(), [])
})

test('an offline node fails with a typed error and records nothing', async () => {
  const { manager } = managerWith({}, 'other')
  await assert.rejects(() => manager.create(draft), /is not connected/)
  assert.deepEqual(anchors.list(), [])
})

test('list joins each anchor with its repository state', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.repoState': { branch: 'main', clean: true },
  })
  await manager.create(draft)

  const statuses = await manager.list()
  assert.equal(statuses.length, 1)
  assert.deepEqual(statuses[0]?.repo, { branch: 'main', clean: true })
  assert.equal(statuses[0]?.error, undefined)
})

test('list reports an offline node per anchor instead of failing the whole listing', async () => {
  const { manager: online } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await online.create(draft)

  const offline = createWorktreeManager({ anchors, channel: () => undefined })
  const statuses = await offline.list()
  assert.match(String(statuses[0]?.error), /is not connected/)
})

test('remove drops the checkout first and the anchor second', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: true, deleteBranch: false })

  assert.deepEqual(calls.map(call => call.method), ['git.worktreeAdd', 'fs.writeText', 'git.worktreeRemove'])
  assert.equal(removal.branchDeleted, false)
  assert.deepEqual(anchors.list(), [])
})

test('removing with deleteBranch also deletes the branch', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': {},
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: false, deleteBranch: true })

  assert.equal(removal.branchDeleted, true)
  assert.deepEqual(calls.at(-1), {
    method: 'git.branchDelete',
    params: { repoPath: '/srv/app', branch: 'worktree/login', force: false },
  })
})

test('a branch that outlives its checkout is reported, not hidden', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': new NodeRequestError({ code: 'GIT_DIRTY', message: 'branch is not fully merged' }),
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: false, deleteBranch: true })

  assert.equal(removal.branchDeleted, false)
  assert.match(String(removal.branchError), /not fully merged/)
  assert.deepEqual(anchors.list(), [])
})

test('a refused checkout removal keeps the anchor, because the content is still there', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': new NodeRequestError({ code: 'GIT_DIRTY', message: 'contains modified files' }),
  })
  const anchor = await manager.create(draft)

  await assert.rejects(() => manager.remove(anchor.anchorId, { force: false, deleteBranch: false }), /modified files/)
  assert.equal(anchors.list().length, 1)
})

test('bringBack merges the anchor branch into the repository branch', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.mergeBranch': { head: 'def', alreadyMerged: false },
  })
  const anchor = await manager.create(draft)

  assert.deepEqual(await manager.bringBack(anchor.anchorId), { head: 'def', alreadyMerged: false })
  assert.deepEqual(calls.at(-1), {
    method: 'git.mergeBranch',
    params: { repoPath: '/srv/app', branch: 'worktree/login' },
  })
})

test('an unknown anchor is refused before any remote call', async () => {
  const { manager, calls } = managerWith({})
  await assert.rejects(() => manager.bringBack(asAnchorId('nope')), /no anchor/)
  assert.deepEqual(calls, [])
})
