/**
 * The lifecycle is where a remote checkout and a local anchor have to stay in
 * step, so its cases are about ordering and partial failure: an anchor is never
 * recorded for a checkout that failed, never kept for one that is gone, and a
 * branch that outlives its checkout is reported rather than hidden.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorStore } from '../../src/storage/anchors.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import type { RepoStore } from '../../src/storage/repos.ts'
import type { NodeChannel } from '../../src/channel.ts'
import { NodeRequestError } from '../../src/channel.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { WorktreeManager } from '../../src/models/worktrees.ts'
import { asNodeId } from '../../src/ids.ts'
import { asAnchorId } from '../../src/ids.ts'

let root: string
let anchors: AnchorStore
let repos: RepoStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drw-worktree-'))
  anchors = createAnchorStore({ root })
  await anchors.load()
  repos = createRepoStore({ file: join(root, 'repos.json') })
  await repos.load()
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A channel recording every call and answering from a script.
 *
 * An answer is the value to resolve with, an `Error` to reject with, or a
 * function of the call's parameters.
 */
function stubChannel(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request(method, params) {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer instanceof Error) return Promise.reject(answer)
      if (typeof answer === 'function') {
        return Promise.resolve((answer as (params: unknown) => unknown)(params)) as never
      }
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${method}`)) as never
      return Promise.resolve(answer) as never
    },
  }
  return { channel, calls }
}

/** A manager over one stub channel, plus the calls it recorded. */
function managerWith(answers: Record<string, unknown>, nodeId = 'n1'): { manager: WorktreeManager; calls: { method: string; params: unknown }[] } {
  // `create` also resolves the repository path and makes the managed directory
  // invisible to git, so every script answers those calls unless a case
  // overrides them.
  const { channel, calls } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    'fs.writeText': {},
    ...answers,
  })
  return {
    manager: createWorktreeManager({ anchors, repos, channel: id => (id === nodeId ? channel : undefined) }),
    calls,
  }
}

/**
 * A manager over one stub channel and a workspace registry that records what
 * it was asked to register.
 * @param answers - the channel's scripted answers.
 * @returns the manager and the registry's journal.
 */
function managerWithWorkspace(answers: Record<string, unknown>): {
  manager: WorktreeManager
  opened: string[]
  closed: string[]
} {
  const { channel } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    'fs.writeText': {},
    ...answers,
  })
  const opened: string[] = []
  const closed: string[] = []
  const live = new Set<string>()
  return {
    opened,
    closed,
    manager: createWorktreeManager({
      anchors,
      repos,
      channel: id => (id === 'n1' ? channel : undefined),
      workspace: {
        register: anchor => { opened.push(anchor.anchorPath); live.add(anchor.anchorPath); return Promise.resolve() },
        unregister: anchor => { closed.push(anchor.anchorPath); live.delete(anchor.anchorPath); return Promise.resolve() },
        registered: anchor => Promise.resolve(live.has(anchor.anchorPath)),
      },
    }),
  }
}

const draft = { nodeId: asNodeId('n1'), repoPath: '/srv/app', name: 'login' }

test('create cuts the checkout and records an anchor at the reported path', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })

  const anchor = await manager.create(draft)

  assert.deepEqual(calls, [
    { method: 'fs.resolve', params: { path: '/srv/app' } },
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
  const add = calls.find(call => call.method === 'git.worktreeAdd')
  assert.equal((add?.params as { baseRef?: string }).baseRef, 'origin/main')
})

test('create cuts under the canonical repository path the daemon reports', async () => {
  const { manager, calls } = managerWith({
    'fs.resolve': { canonicalPath: '/srv/app' },
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })

  const anchor = await manager.create({ ...draft, repoPath: '/srv/app/' })

  const add = calls.find(call => call.method === 'git.worktreeAdd')
  assert.deepEqual(add?.params, {
    repoPath: '/srv/app',
    worktreePath: '/srv/app/.dsh-worktrees/worktree/login',
    branch: 'worktree/login',
  })
  assert.equal(anchor.repoPath, '/srv/app', 'the anchor carries the same spelling the guards look up')
})

test('create records the repository the worktree came from', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  assert.deepEqual(repos.list().map(repo => repo.repoPath), ['/srv/app'])
})

test('create keeps the name a person gave an already-registered repository', async () => {
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath: '/srv/app', name: 'the app' })
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  assert.equal(repos.list().length, 1)
  assert.equal(repos.list()[0]?.name, 'the app')
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

test('list answers from local records without asking the node', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  const statuses = await manager.list()
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0]?.anchor.branch, 'worktree/login')
  assert.equal(statuses[0]?.open, false, 'no registry is composed here, so nothing is open')
  assert.equal(statuses[0]?.error, undefined)
})

test('list reports an offline node per anchor instead of failing the whole listing', async () => {
  const { manager: online } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await online.create(draft)

  const offline = createWorktreeManager({ anchors, repos, channel: () => undefined })
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

  assert.deepEqual(calls.map(call => call.method), ['fs.resolve', 'git.worktreeAdd', 'fs.writeText', 'git.worktreeRemove'])
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

test('removal unregisters the workspace while the anchor directory is still there', async () => {
  // The registry resolves an entry by path, so unregistering after the anchor
  // directory is gone would leave a dead entry in the sidebar and in the
  // store — the exact state a person cannot clear from the section.
  const { channel } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    'fs.writeText': {},
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
  })
  const seen: boolean[] = []
  const manager = createWorktreeManager({
    anchors,
    repos,
    channel: id => (id === 'n1' ? channel : undefined),
    workspace: {
      register: () => Promise.resolve(),
      unregister: anchor => { seen.push(existsSync(anchor.anchorPath)); return Promise.resolve() },
      registered: () => Promise.resolve(false),
    },
  })
  const anchor = await manager.create(draft)

  await manager.remove(anchor.anchorId, { force: false, deleteBranch: false })

  assert.deepEqual(seen, [true], 'the entry was resolved before its directory went away')
  assert.equal(existsSync(anchor.anchorPath), false, 'and the anchor is gone afterwards')
})

test('closing and opening a worktree move only its workspace registration', async () => {
  const { manager, opened, closed } = managerWithWorkspace({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  // Creation registers the workspace, so the checkout starts open.
  assert.deepEqual(opened, [anchor.anchorPath])
  assert.equal((await manager.list())[0]?.open, true)

  await manager.close(anchor.anchorId)
  assert.deepEqual(closed, [anchor.anchorPath])
  assert.equal((await manager.list())[0]?.open, false)
  // Closing says nothing about the machine: the checkout is still there.
  assert.equal(anchors.list().length, 1)

  await manager.open(anchor.anchorId)
  assert.equal((await manager.list())[0]?.open, true)
})

test('opening without a workspace registry says so instead of failing silently', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  await assert.rejects(() => manager.open(anchor.anchorId), /no workspace registry/)
})

test('an unknown anchor is refused before any remote call', async () => {
  const { manager, calls } = managerWith({})
  await assert.rejects(() => manager.open(asAnchorId('nope')), /no anchor/)
  await assert.rejects(() => manager.close(asAnchorId('nope')), /no anchor/)
  assert.deepEqual(calls, [])
})
