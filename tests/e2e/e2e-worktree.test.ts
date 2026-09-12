/**
 * The P3 loop against real git: a real repository on a real socket, a worktree
 * cut through the wire, worked in, and removed again. The branch outlives the
 * checkout unless the caller explicitly asks for it.
 *
 * The local anchor is asserted on disk at every step, because the anchor is
 * what makes the remote checkout addressable by the rest of the harness.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorStore } from '../../src/storage/anchors.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import type { RepoStore } from '../../src/storage/repos.ts'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { WorktreeManager } from '../../src/models/worktrees.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import type { AnchorId } from '../../src/storage/anchors.ts'

const run = promisify(execFile)
const TOKEN = 'worktree-token-0123456789'

let repoPath: string
let dataDir: string
let server: TestAgent
let node: ConnectedNode
let anchors: AnchorStore
let repos: RepoStore
let worktrees: WorktreeManager

/** Run git in the fixture repository with a fixed identity. */
async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await run('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd })
  return stdout.trim()
}

before(async () => {
  repoPath = await realpath(await mkdtemp(join(tmpdir(), 'drw-wt-repo-')))
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'drw-wt-data-')))

  await run('git', ['init', '-b', 'main'], { cwd: repoPath })
  await writeFile(join(repoPath, 'README.md'), 'initial\n', 'utf8')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  server = await startAgent({ token: TOKEN, root: repoPath })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  anchors = createAnchorStore({ root: join(dataDir, 'anchors') })
  await anchors.load()
  repos = createRepoStore({ file: join(dataDir, 'repos.json') })
  await repos.load()
  worktrees = createWorktreeManager({
    anchors,
    repos,
    channel: nodeId => (nodeId === 'n1' ? node.channel : undefined),
  })
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(repoPath, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

let anchorId: AnchorId

test('creating a worktree cuts a real checkout and records an anchor', async () => {
  const anchor = await worktrees.create({ nodeId: asNodeId('n1'), repoPath, name: 'login' })
  anchorId = anchor.anchorId

  assert.equal(anchor.branch, 'worktree/login')
  assert.equal(anchor.remoteRoot, join(repoPath, '.dsh-worktrees', 'worktree', 'login'))
  assert.equal(existsSync(anchor.remoteRoot), true)
  assert.equal(existsSync(anchor.anchorPath), true)
  assert.equal(existsSync(join(anchor.anchorPath, '.dsh-remote-worktree.json')), true)

  const branches = await git(['branch', '--list', '--format=%(refname:short)', 'worktree/login'])
  assert.equal(branches, 'worktree/login')
  // The daemon canonicalized the path, and the record carries that spelling:
  // it is what groups this worktree under its repository everywhere else.
  assert.deepEqual(repos.list().map(repo => repo.repoPath), [anchor.repoPath])
})

test('the worktree carries the base revision content', async () => {
  const content = await readFile(join(repoPath, '.dsh-worktrees', 'worktree', 'login', 'README.md'), 'utf8')
  assert.equal(content, 'initial\n')
})

test('listing reports each anchor and whether it is open', async () => {
  const statuses = await worktrees.list()
  assert.equal(statuses.length, 1)
  const listed = statuses[0]?.anchor
  assert.ok(listed?.kind === 'worktree', 'the anchor is a worktree')
  assert.equal(listed.branch, 'worktree/login')
  assert.equal(statuses[0]?.open, false, 'nothing registered a workspace here')
})

test('a commit in the worktree stays on its branch', async () => {
  const checkout = join(repoPath, '.dsh-worktrees', 'worktree', 'login')
  await writeFile(join(checkout, 'feature.txt'), 'from the worktree\n', 'utf8')
  await git(['add', '.'], checkout)
  await git(['commit', '-m', 'add feature'], checkout)

  assert.equal(existsSync(join(repoPath, 'feature.txt')), false, 'main is untouched until someone merges')
})

test('a dirty checkout refuses removal until it is forced', async () => {
  const checkout = join(repoPath, '.dsh-worktrees', 'worktree', 'login')
  await writeFile(join(checkout, 'README.md'), 'locally modified\n', 'utf8')

  await assert.rejects(
    () => worktrees.remove(anchorId, { force: false, deleteBranch: false }),
    (error: unknown) => (error as { data?: { code?: string } }).data?.code === 'GIT_DIRTY',
  )
  assert.equal(anchors.list().length, 1, 'a refused removal keeps the anchor')
})

test('a forced removal drops the checkout and the anchor but keeps the branch', async () => {
  const removal = await worktrees.remove(anchorId, { force: true, deleteBranch: false })

  assert.equal(removal.branchDeleted, false)
  assert.equal(existsSync(join(repoPath, '.dsh-worktrees', 'worktree', 'login')), false)
  assert.deepEqual(anchors.list(), [])
  assert.equal(await git(['branch', '--list', '--format=%(refname:short)', 'worktree/login']), 'worktree/login')
})

test('remove with deleteBranch takes the branch with the checkout', async () => {
  const anchor = await worktrees.create({ nodeId: asNodeId('n1'), repoPath, name: 'signup' })
  const removal = await worktrees.remove(anchor.anchorId, { force: false, deleteBranch: true })

  assert.equal(removal.branchDeleted, true)
  assert.equal(await git(['branch', '--list', '--format=%(refname:short)', 'worktree/signup']), '')
})
