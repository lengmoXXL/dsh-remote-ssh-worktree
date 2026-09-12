/**
 * The management API is a wire boundary: everything it accepts is untrusted and
 * everything it returns can reach a browser. These cases pin the three rules
 * that matter — a bad body is a client error, a node's secret never leaves the
 * host, and an operation that needs a connection says so instead of failing
 * obscurely.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeChannel } from '../../src/channel.ts'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorRecord } from '../../src/storage/anchors.ts'
import { createNodeConnections } from '../../src/models/machines.ts'
import { createNodeRegistry } from '../../src/storage/nodes.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { WireMethods } from '../../src/protocol.ts'
import type { ApiRequest } from '../../src/plugin/api.ts'
import { handleNodeApi } from '../../src/plugin/api.ts'
import { asNodeId, asRepoId } from '../../src/ids.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drw-api-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A registry, repository store, and connection manager sharing one temp directory. */
async function setup(connect?: Parameters<typeof createNodeConnections>[0]) {
  const registry = createNodeRegistry({ file: join(dir, 'nodes.json') })
  await registry.load()
  const repos = createRepoStore({ file: join(dir, 'repos.json') })
  await repos.load()
  const connections = createNodeConnections({
    ...connect ?? {},
    // No test may install an agent over `ssh`: the recorded destination is a
    // placeholder, and the opener is stubbed to a fixed loopback port.
    openTransport: record => Promise.resolve(
      record.transport.kind === 'direct'
        ? { host: record.transport.host, port: record.transport.port, close: () => {} }
        : { host: '127.0.0.1', port: 1, close: () => {} },
    ),
  })
  const anchors = createAnchorStore({ root: join(dir, 'anchors') })
  await anchors.load()
  // Workspace registration is a seam: the deployment normally supplies it, and
  // a set is enough to tell "opened as a workspace" from "merely recorded".
  const registered = new Set<string>()
  const workspace = {
    register: (anchor: AnchorRecord) => { registered.add(anchor.anchorId); return Promise.resolve() },
    unregister: (anchor: AnchorRecord) => { registered.delete(anchor.anchorId); return Promise.resolve() },
    registered: (anchor: AnchorRecord) => Promise.resolve(registered.has(anchor.anchorId)),
  }
  const worktrees = createWorktreeManager({
    anchors, repos, channel: nodeId => connections.channel(nodeId), workspace,
  })
  return {
    registry,
    repos,
    connections,
    anchors,
    worktrees,
    registered,
    deps: { registry, repos, connections, worktrees },
  }
}

/** A request with a JSON body. */
function request(method: string, path: string, body?: unknown, query = ''): ApiRequest {
  return { method, path, query: new URLSearchParams(query), body }
}

test('an empty install lists no nodes', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('GET', '/nodes'), deps)
  assert.deepEqual(response, { status: 200, body: { nodes: [], statuses: [] } })
})

test('creating a node answers with a view that carries no secret', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(
    request('POST', '/nodes', { ssh: { target: 'build-01' }, token: 'hunter2' }),
    deps,
  )

  assert.equal(response.status, 201)
  assert.equal(JSON.stringify(response.body).includes('hunter2'), false)
  const node = (response.body as { node: { title: string; hasToken: boolean } }).node
  assert.equal(node.title, 'build-01')
  assert.equal(node.hasToken, true)
})

test('a node list never carries a secret either', async () => {
  const { deps } = await setup()
  await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 'hunter2' }), deps)
  const response = await handleNodeApi(request('GET', '/nodes'), deps)
  assert.equal(JSON.stringify(response.body).includes('hunter2'), false)
})

test('a missing host is a client error, not a created node', async () => {
  const { deps, registry } = await setup()
  const response = await handleNodeApi(request('POST', '/nodes', { token: 't' }), deps)
  assert.equal(response.status, 400)
  assert.deepEqual(registry.list(), [])
})

test('a node cannot be created without a token', async () => {
  const { deps, registry } = await setup()
  const response = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' } }), deps)
  assert.equal(response.status, 400)
  assert.deepEqual(registry.list(), [])
})

test('reading one node joins its live status', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}`), deps)
  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { status: { state: string } }).status, {
    nodeId,
    state: 'idle',
  })
})

test('an unknown node is a 404 on every verb that names one', async () => {
  const { deps } = await setup()
  for (const [method, path] of [['GET', '/nodes/nope'], ['DELETE', '/nodes/nope'], ['POST', '/nodes/nope/connect']] as const) {
    const response = await handleNodeApi(request(method, path), deps)
    assert.equal(response.status, 404, `${method} ${path}`)
  }
})

test('patching keeps the fields the caller omitted', async () => {
  const { deps, registry } = await setup()
  const created = await handleNodeApi(
    request('POST', '/nodes', { ssh: { target: 'a' }, token: 't', title: 'First' }),
    deps,
  )
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  await handleNodeApi(request('PATCH', `/nodes/${nodeId}`, { title: 'Second' }), deps)
  const record = registry.get(nodeId)
  assert.equal(record?.title, 'Second')
  assert.equal(record?.transport.kind === 'ssh' ? record.transport.target : '', 'a')
  assert.equal(record?.token, 't')
})

test('deleting a node disconnects it and drops the record', async () => {
  const { deps, registry } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('DELETE', `/nodes/${nodeId}`), deps)
  assert.deepEqual(response, { status: 200, body: { deleted: true } })
  assert.deepEqual(registry.list(), [])
})

test('connecting reports the daemon facts', async () => {
  const info = {
    protocol: 1,
    agentVersion: '0.0.1',
    platform: 'linux',
    arch: 'x64',
    node: 'v22.19.0',
    homedir: '/home/dev',
    capability: { pty: false, spill: false, ripgrep: null },
  }
  const { deps } = await setup({
    connect: () => Promise.resolve({ info, channel: { request: () => Promise.reject(new Error('unused')), onPipeFrame: () => () => {} }, close: () => {} }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)
  assert.equal(response.status, 200)
  assert.equal((response.body as { status: { state: string } }).status.state, 'ready')
})

test('a failed connection is reported, not swallowed', async () => {
  const { deps } = await setup({ connect: () => Promise.reject(new Error('connection refused')) })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)
  assert.equal(response.status, 502)
  assert.match(String((response.body as { error: string }).error), /connection refused/)
})

test('browsing directories without a connection is a conflict, not a crash', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}/dirs`, undefined, 'path=/srv'), deps)
  assert.equal(response.status, 409)
})

test('browsing directories lists resolved children', async () => {
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request: (method) => {
      if (method === 'fs.resolve') return Promise.resolve({ canonicalPath: '/srv/app' }) as never
      if (method === 'fs.listDir') {
        return Promise.resolve([
          { name: 'src', type: 'directory', target: { canonicalPath: '/srv/app/src' } },
          { name: 'readme.md', type: 'file', target: { canonicalPath: '/srv/app/readme.md' }, size: 12 },
        ]) as never
      }
      return Promise.reject(new Error(`unexpected ${method}`)) as never
    },
  }
  const { deps } = await setup({
    connect: () => Promise.resolve({
      info: {
        protocol: 1,
        agentVersion: '0.0.1',
        platform: 'linux',
        arch: 'x64',
        node: 'v22.19.0',
        homedir: '/home/dev',
        capability: { pty: false, spill: false, ripgrep: null },
      },
      channel,
      close: () => {},
    }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}/dirs`, undefined, 'path=/srv'), deps)
  assert.deepEqual(response, {
    status: 200,
    body: {
      path: '/srv/app',
      entries: [
        { name: 'src', type: 'directory', path: '/srv/app/src' },
        { name: 'readme.md', type: 'file', path: '/srv/app/readme.md', size: 12 },
      ],
    },
  })
})

test('an unknown endpoint is a 404 and a wrong verb is a 405', async () => {
  const { deps } = await setup()
  assert.equal((await handleNodeApi(request('GET', '/nope'), deps)).status, 404)
  assert.equal((await handleNodeApi(request('PUT', '/nodes'), deps)).status, 405)
})

test('an empty anchor store lists no worktrees', async () => {
  const { deps } = await setup()
  assert.deepEqual(await handleNodeApi(request('GET', '/worktrees'), deps), {
    status: 200,
    body: { worktrees: [] },
  })
})

test('creating a worktree requires its three coordinates', async () => {
  const { deps, anchors } = await setup()
  for (const body of [{ repoPath: '/srv/app', name: 'x' }, { nodeId: asNodeId('n1'), name: 'x' }, { nodeId: asNodeId('n1'), repoPath: '/srv/app' }]) {
    const response = await handleNodeApi(request('POST', '/worktrees', body), deps)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.deepEqual(anchors.list(), [])
})

test('removing an unknown worktree is reported by the lifecycle', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('DELETE', '/worktrees/nope'), deps)
  assert.equal(response.status, 502)
  assert.match(String((response.body as { error: string }).error), /no anchor/)
})

test('removing a worktree keeps its branch unless the query asks for it', async () => {
  const { deps, anchorId, calls } = await cutWorktree({ 'git.worktreeRemove': () => ({}) })
  calls.length = 0

  const response = await handleNodeApi(request('DELETE', `/worktrees/${anchorId}`), deps)

  assert.equal(response.status, 200)
  assert.equal((response.body as { removal: { branchDeleted: boolean } }).removal.branchDeleted, false)
  assert.equal(calls.includes('git.branchDelete'), false, 'the default never asks for the branch')
})

test('removing a worktree with deleteBranch=true takes the branch too', async () => {
  const { deps, anchorId } = await cutWorktree({
    'git.worktreeRemove': () => ({}),
    'git.branchDelete': () => ({}),
  })

  const response = await handleNodeApi(
    request('DELETE', `/worktrees/${anchorId}`, undefined, 'deleteBranch=true'), deps,
  )

  assert.equal(response.status, 200)
  assert.equal((response.body as { removal: { branchDeleted: boolean } }).removal.branchDeleted, true)
})

test('opening and closing a worktree touch no checkout', async () => {
  const { deps, anchorId, calls, registered } = await cutWorktree()
  calls.length = 0

  const opened = await handleNodeApi(request('POST', `/worktrees/${anchorId}/open`), deps)
  assert.equal(registered.has(String(anchorId)), true)
  const closed = await handleNodeApi(request('POST', `/worktrees/${anchorId}/close`), deps)

  assert.equal(opened.status, 200)
  assert.equal(closed.status, 200)
  assert.equal(registered.has(String(anchorId)), false)
  assert.deepEqual(calls, [], 'neither action reaches the machine')
})

test('a worktree action answers only to POST, and an unknown action deletes nothing', async () => {
  const { deps, anchorId } = await cutWorktree()
  assert.equal((await handleNodeApi(request('GET', `/worktrees/${anchorId}/open`), deps)).status, 405)
  assert.equal((await handleNodeApi(request('DELETE', `/worktrees/${anchorId}/bogus`), deps)).status, 404)
  const list = await handleNodeApi(request('GET', '/worktrees'), deps)
  assert.equal((list.body as { worktrees: readonly unknown[] }).worktrees.length, 1, 'the checkout survived')
})

/**
 * Cut one worktree through the API over a recording fake daemon.
 * @param overrides - daemon methods this case needs an answer for.
 * @returns the connected context plus the anchor id and every method asked for.
 */
async function cutWorktree(overrides: Readonly<Record<string, (params: never) => unknown>> = {}) {
  const calls: string[] = []
  const inner = daemon(overrides)
  const channel: NodeChannel = {
    ...inner,
    request: ((method: keyof WireMethods, params: never) => {
      calls.push(method)
      return inner.request(method, params)
    }) as NodeChannel['request'],
  }
  const context = await connected(channel)
  const created = await handleNodeApi(
    request('POST', '/worktrees', { nodeId: context.nodeId, repoPath: '/srv/app', name: 'x' }),
    context.deps,
  )
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const anchorId = (created.body as { worktree: { anchorId: string } }).worktree.anchorId
  return { ...context, anchorId, calls }
}

/** A fake daemon whose repository probe succeeds unless overridden. */
function daemon(overrides: Readonly<Record<string, (params: never) => unknown>> = {}): NodeChannel {
  return {
    onPipeFrame: () => () => {},
    request: ((method: string, params: { path: string; repoPath: string }) => {
      const override = overrides[method]
      if (override !== undefined) return Promise.resolve(override(params as never)) as never
      if (method === 'fs.resolve') return Promise.resolve({ canonicalPath: params.path }) as never
      if (method === 'git.repoState') return Promise.resolve({ branch: 'main', clean: true }) as never
      if (method === 'git.worktreeAdd') return Promise.resolve({ path: `${params.repoPath}/.dsh-worktrees/worktree/x`, branch: 'worktree/x' }) as never
      if (method === 'fs.writeText') return Promise.resolve({}) as never
      return Promise.reject(new Error(`unexpected ${method}`)) as never
    }) as NodeChannel['request'],
  }
}

/** A registry holding one node already connected to a fake daemon. */
async function connected(channel: NodeChannel) {
  const context = await setup({
    connect: () => Promise.resolve({
      info: {
        protocol: 1,
        agentVersion: '0.0.1',
        platform: 'linux',
        arch: 'x64',
        node: 'v22.19.0',
        homedir: '/home/dev',
        capability: { pty: false, spill: false, ripgrep: null },
      },
      channel,
      close: () => {},
    }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), context.deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), context.deps)
  return { ...context, nodeId }
}

test('an empty repository store lists no repositories', async () => {
  const { deps } = await setup()
  assert.deepEqual(await handleNodeApi(request('GET', '/repos'), deps), {
    status: 200,
    body: { repos: [] },
  })
})

test('registering a repository requires its machine and path', async () => {
  const { deps } = await setup()
  for (const body of [{ repoPath: '/srv/app' }, { nodeId: asNodeId('n1') }]) {
    assert.equal((await handleNodeApi(request('POST', '/repos', body), deps)).status, 400)
  }
})

test('registering a repository on an unknown machine is a 404', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('POST', '/repos', { nodeId: asNodeId('nope'), repoPath: '/srv/app' }), deps)
  assert.equal(response.status, 404)
})

test('registering a repository without a connection is a conflict', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  const response = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)
  assert.equal(response.status, 409)
})

test('a registered path is canonicalized and named from the machine', async () => {
  const { deps, repos } = await connected(daemon())
  const response = await handleNodeApi(
    request('POST', '/repos', { nodeId: (await deps.registry.list())[0]!.nodeId, repoPath: '/srv/app' }),
    deps,
  )
  assert.equal(response.status, 201)
  assert.equal(repos.list()[0]?.repoPath, '/srv/app')
  assert.equal(repos.list()[0]?.name, 'app')
  assert.equal(JSON.stringify(response.body).includes('"state"'), true)
})

test('re-registering the same path answers 200 and keeps one record', async () => {
  const channel = daemon()
  const { deps, repos, nodeId } = await connected(channel)
  const first = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)
  const second = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)

  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(repos.list().length, 1)
})

test('a path that is not a git repository is refused with the reason', async () => {
  const channel = daemon({
    'git.repoState': () => { throw new Error('not a git repository') },
  })
  const { deps, repos, nodeId } = await connected(channel)
  const response = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/plain' }), deps)

  assert.equal(response.status, 400)
  assert.match(String((response.body as { error: string }).error), /not a git repository/)
  assert.deepEqual(repos.list(), [])
})

test('an offline machine still lists its repositories and says why state is missing', async () => {
  const { deps, repos } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('GET', '/repos'), deps)
  const report = (response.body as { repos: readonly { repo: { name: string }; error?: string }[] }).repos[0]
  assert.equal(response.status, 200)
  assert.equal(report?.repo.name, 'app')
  assert.match(String(report?.error), /not connected/)
})

test('removing an unknown repository is a 404', async () => {
  const { deps } = await setup()
  assert.equal((await handleNodeApi(request('DELETE', '/repos/nope'), deps)).status, 404)
})

test('forgetting a repository is refused while worktrees still belong to it', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })
  await anchors.create({
    nodeId,
    name: 'x',
    repoPath: '/srv/app',
    remoteRoot: '/srv/app/.dsh-worktrees/worktree/x',
    branch: 'worktree/x',
  })

  const response = await handleNodeApi(request('DELETE', `/repos/${repo.repoId}`), deps)
  assert.equal(response.status, 409)
  assert.match(String((response.body as { error: string }).error), /1 worktree/)
  assert.equal(repos.list().length, 1)
})

test('forgetting a free repository drops exactly that record', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('DELETE', `/repos/${repo.repoId}`), deps)
  assert.deepEqual(response, { status: 200, body: { deleted: true } })
  assert.deepEqual(repos.list(), [])
})

test('creating a worktree from a repository id resolves its machine and path', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('POST', '/worktrees', { repoId: repo.repoId, name: 'x' }), deps)
  assert.equal(response.status, 201)
  assert.equal(anchors.list()[0]?.repoPath, '/srv/app')
  assert.equal(anchors.list()[0]?.nodeId, nodeId)
})

test('creating a worktree from an unknown repository id is a 404', async () => {
  const { deps, anchors } = await connected(daemon())
  const response = await handleNodeApi(request('POST', '/worktrees', { repoId: asRepoId('nope'), name: 'x' }), deps)
  assert.equal(response.status, 404)
  assert.deepEqual(anchors.list(), [])
})

test('a worktree cut by path still registers its repository', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const response = await handleNodeApi(
    request('POST', '/worktrees', { nodeId, repoPath: '/srv/app', name: 'x' }),
    deps,
  )

  assert.equal(response.status, 201)
  assert.deepEqual(repos.list().map(repo => repo.repoPath), ['/srv/app'])
})

test('removing a machine drops its repository registrations', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  await repos.upsert({ nodeId, repoPath: '/srv/app' })

  await handleNodeApi(request('DELETE', `/nodes/${nodeId}`), deps)
  assert.deepEqual(repos.list(), [])
})
