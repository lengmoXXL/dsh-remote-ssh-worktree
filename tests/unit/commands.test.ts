/**
 * `/rwt` is the surface a human uses when they do not want to talk to the
 * model, so its cases are about the three things a person needs to be told:
 * what exists, what a command actually did, and what to type next.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnchorStore } from '../../src/plugin/anchors.ts'
import type { AnchorStore } from '../../src/plugin/anchors.ts'
import { createRepoStore } from '../../src/repos/store.ts'
import type { RepoStore } from '../../src/repos/store.ts'
import type { NodeConnections, NodeState } from '../../src/nodes/connections.ts'
import type { NodeRecord, NodeRegistry } from '../../src/nodes/registry.ts'
import { createWorktreeManager } from '../../src/worktree/manager.ts'
import { runWorktreeCommand } from '../../src/plugin/commands.ts'
import type { WorktreeCommandDeps } from '../../src/plugin/commands.ts'
import { asNodeId } from '../../src/ids.ts'

let root: string
let anchors: AnchorStore
let repos: RepoStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drw-cmd-'))
  anchors = createAnchorStore({ root })
  await anchors.load()
  repos = createRepoStore({ file: join(root, 'repos.json') })
  await repos.load()
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const record: NodeRecord = {
  nodeId: asNodeId('n1'),
  title: 'build-01',
  transport: { kind: 'direct', host: 'build-01', port: 7801 },
  token: 'secret',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** A registry stub over a fixed list. */
function registryOf(nodes: readonly NodeRecord[]): NodeRegistry {
  return {
    load: () => Promise.resolve(nodes),
    list: () => nodes,
    get: nodeId => nodes.find(node => node.nodeId === nodeId),
    upsert: () => Promise.reject(new Error('unused')),
    remove: () => Promise.resolve(false),
  }
}

/** A connections stub whose channel answers from a script. */
function connectionsOf(
  channel: (nodeId: string) => unknown,
  state: NodeState = 'ready',
): NodeConnections {
  return {
    channel: nodeId => channel(nodeId) as never,
    status: nodeId => ({ nodeId, state }),
    list: () => [],
    connect: () => Promise.resolve({
      protocol: 1,
      agentVersion: 'test',
      platform: 'linux',
      arch: 'x64',
      node: 'v22',
      homedir: '/home/dev',
      capability: { pty: false, spill: false, ripgrep: null },
    }),
    disconnect: () => {},
    dispose: () => {},
  }
}

/** Deps over one stub channel script. */
function depsWith(
  answers: Record<string, unknown>,
  nodes: readonly NodeRecord[] = [record],
  state: NodeState = 'ready',
): WorktreeCommandDeps {
  const channel = {
    request: (method: string, params: { path: string }) => {
      if (method === 'fs.resolve') return Promise.resolve({ canonicalPath: params.path })
      const answer = answers[method]
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return {
    worktrees: createWorktreeManager({ anchors, repos, channel: id => (id === 'n1' ? channel as never : undefined) }),
    registry: registryOf(nodes),
    connections: connectionsOf(id => (id === 'n1' ? channel : undefined), state),
  }
}

test('an empty worktree list says so and points at the machine list', async () => {
  const result = await runWorktreeCommand('list', depsWith({}))
  assert.equal(result.kind, 'success')
  assert.match(String(result.text), /No remote worktrees/)
})

test('a bare invocation lists, so `/rwt` alone is useful', async () => {
  const result = await runWorktreeCommand('', depsWith({}))
  assert.equal(result.kind, 'success')
  assert.match(String(result.text), /No remote worktrees/)
})

test('an empty machine list says where to add one', async () => {
  const result = await runWorktreeCommand('nodes', depsWith({}, []))
  assert.match(String(result.text), /No machines configured/)
})

test('the machine list shows each node and its connection state', async () => {
  const result = await runWorktreeCommand('nodes', depsWith({}))
  assert.match(String(result.text), /n1\s+build-01\s+build-01:7801\s+ready/)
})

test('a created worktree is reported with both paths and the cleanup commands', async () => {
  const deps = depsWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const result = await runWorktreeCommand('create n1 /srv/app login', deps)

  assert.equal(result.kind, 'success')
  assert.match(String(result.text), /Created worktree\/login on n1/)
  assert.match(String(result.text), /\/srv\/app\/\.dsh-worktrees\/worktree\/login/)
  assert.match(String(result.text), /\/rwt remove /)
})

test('create with too few arguments refuses instead of guessing', async () => {
  const result = await runWorktreeCommand('create n1 /srv/app', depsWith({}))
  assert.equal(result.kind, 'error')
  assert.match(String(result.text), /usage: \/rwt/)
  assert.deepEqual(anchors.list(), [])
})

test('create against an unknown machine refuses before any connection', async () => {
  const result = await runWorktreeCommand('create nope /srv/app login', depsWith({}))
  assert.equal(result.kind, 'error')
  assert.match(String(result.text), /no node "nope"/)
})

test('a refused create reports the git failure verbatim', async () => {
  const { NodeRequestError } = await import('../../src/channel.ts')
  const deps = depsWith({
    'git.worktreeAdd': new NodeRequestError({ code: 'GIT_BRANCH_EXISTS', message: 'branch already exists' }),
  })
  const result = await runWorktreeCommand('create n1 /srv/app login', deps)

  assert.equal(result.kind, 'error')
  assert.match(String(result.text), /branch already exists/)
  assert.deepEqual(anchors.list(), [])
})

test('the worktree list shows each anchor, its machine, and whether it is open', async () => {
  const deps = depsWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await runWorktreeCommand('create n1 /srv/app login', deps)
  const result = await runWorktreeCommand('list', deps)

  assert.match(String(result.text), /n1:worktree\/login\s+closed/)
  assert.match(String(result.text), /node:\s+\/srv\/app\/\.dsh-worktrees\/worktree\/login/)
})

test('remove leaves the branch behind unless the caller asks for it', async () => {
  const deps = depsWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
  })
  await runWorktreeCommand('create n1 /srv/app login', deps)
  const anchorId = anchors.list()[0]!.anchorId

  const result = await runWorktreeCommand(`remove ${anchorId}`, deps)
  assert.equal(result.kind, 'success')
  assert.match(String(result.text), /Removed worktree\/login; the branch is still there/)
})

test('remove --delete-branch takes the branch with the checkout', async () => {
  const deps = depsWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': {},
  })
  await runWorktreeCommand('create n1 /srv/app login', deps)
  const anchorId = anchors.list()[0]!.anchorId

  const result = await runWorktreeCommand(`remove ${anchorId} --delete-branch`, deps)
  assert.equal(result.kind, 'success')
  assert.match(String(result.text), /Removed worktree\/login and its branch/)
})

test('remove --delete-branch says so when the branch refuses to go', async () => {
  const { NodeRequestError } = await import('../../src/channel.ts')
  const deps = depsWith({
    'git.worktreeAdd': { path: '/srv/app/.dsh-worktrees/worktree/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': new NodeRequestError({ code: 'GIT_DIRTY', message: 'not fully merged' }),
  })
  await runWorktreeCommand('create n1 /srv/app login', deps)
  const anchorId = anchors.list()[0]!.anchorId

  const result = await runWorktreeCommand(`remove ${anchorId} --delete-branch`, deps)
  assert.match(String(result.text), /The branch could not be deleted: not fully merged/)
})

test('an unknown subcommand prints the usage line', async () => {
  const result = await runWorktreeCommand('frobnicate', depsWith({}))
  assert.equal(result.kind, 'error')
  assert.match(String(result.text), /unknown subcommand "frobnicate"/)
})
