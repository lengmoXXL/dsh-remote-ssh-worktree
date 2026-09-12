/**
 * An anchor is the only thing that makes a remote worktree addressable by the
 * rest of the harness, so its cases are about identity: the directory is real,
 * the metadata survives a restart, two anchors never share one directory, and a
 * document this build cannot read is a failure rather than a silently missing
 * worktree.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnchorDraft } from '../../src/storage/anchors.ts'
import { ANCHOR_FILE, createAnchorStore } from '../../src/storage/anchors.ts'
import { asNodeId } from '../../src/ids.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drw-anchors-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const draft: AnchorDraft = {
  nodeId: asNodeId('n1'),
  kind: 'worktree',
  name: 'login',
  repoPath: '/srv/app',
  remoteRoot: '/srv/app/.dsh-worktrees/worktree/worktree/login',
  branch: 'worktree/login',
}

test('a missing root loads as no anchors', async () => {
  const store = createAnchorStore({ root: join(root, 'absent') })
  assert.deepEqual(await store.load(), [])
})

test('create makes a real directory carrying the remote coordinates', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  const anchor = await store.create(draft)

  assert.equal(anchor.anchorPath, join(root, 'n1', 'app', 'login'))
  assert.equal(existsSync(anchor.anchorPath), true)
  const written = JSON.parse(await readFile(join(anchor.anchorPath, ANCHOR_FILE), 'utf8'))
  assert.equal(written.version, 1)
  assert.equal(written.anchor.remoteRoot, draft.remoteRoot)
})

test('an anchor survives a reload', async () => {
  const first = createAnchorStore({ root })
  await first.load()
  const created = await first.create(draft)

  const second = createAnchorStore({ root })
  assert.deepEqual(await second.load(), [created])
})

test('routes project the records the classifier reads', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  const anchor = await store.create(draft)

  assert.deepEqual(store.routes(), [{
    nodeId: asNodeId('n1'),
    anchorPath: anchor.anchorPath,
    remoteRoot: draft.remoteRoot,
  }])
})

test('two anchors never share one directory', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  await store.create(draft)
  await assert.rejects(() => store.create(draft), /already owns/)
})

test('distinct names under one repository coexist', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  const a = await store.create({ ...draft, name: 'a' })
  const b = await store.create({ ...draft, name: 'b' })

  assert.notEqual(a.anchorPath, b.anchorPath)
  assert.equal(store.list().length, 2)
})

test('remove deletes the directory and reports what it removed', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  const anchor = await store.create(draft)

  assert.deepEqual(await store.remove(anchor.anchorId), anchor)
  assert.equal(existsSync(anchor.anchorPath), false)
  assert.deepEqual(store.list(), [])
  assert.equal(await store.remove(anchor.anchorId), undefined)
})

test('a directory anchor sits beside the worktrees and carries no branch', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  await store.create(draft)
  const directory = await store.create({
    nodeId: asNodeId('n1'),
    kind: 'directory',
    name: 'app',
    repoPath: '/srv/app',
    remoteRoot: '/srv/app',
  })

  assert.equal(directory.anchorPath, join(root, 'n1', 'app', '.self'))
  assert.equal(directory.kind, 'directory')
  assert.equal('branch' in directory, false)
  // Neither anchor claims the other's directory, so no path routes two ways.
  const reloaded = await createAnchorStore({ root }).load()
  assert.deepEqual(reloaded.map(anchor => anchor.kind).sort(), ['directory', 'worktree'])
})

test('an anchor written before kinds existed reads as a worktree', async () => {
  const dir = join(root, 'n1', 'app', 'old')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, ANCHOR_FILE), JSON.stringify({
    version: 1,
    anchor: {
      anchorId: 'a-1',
      nodeId: 'n1',
      name: 'old',
      anchorPath: dir,
      remoteRoot: '/srv/app/.dsh-worktrees/worktree/old',
      repoPath: '/srv/app',
      branch: 'worktree/old',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }), 'utf8')

  const [anchor] = await createAnchorStore({ root }).load()
  assert.equal(anchor?.kind, 'worktree')
  assert.equal(anchor?.kind === 'worktree' ? anchor.branch : undefined, 'worktree/old')
})

test('a malformed anchor document fails loud instead of disappearing', async () => {
  const dir = join(root, 'n1', 'app', 'broken')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, ANCHOR_FILE), 'not json', 'utf8')

  const store = createAnchorStore({ root })
  await assert.rejects(() => store.load(), /not valid JSON/)
})

test('an anchor from another build version is refused', async () => {
  const dir = join(root, 'n1', 'app', 'future')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, ANCHOR_FILE), JSON.stringify({ version: 9, anchor: {} }), 'utf8')

  const store = createAnchorStore({ root })
  await assert.rejects(() => store.load(), /document version 9/)
})

test('unrelated files in the tree are ignored', async () => {
  const store = createAnchorStore({ root })
  await store.load()
  await store.create(draft)
  await writeFile(join(root, 'n1', 'stray.txt'), 'x', 'utf8')

  const reloaded = createAnchorStore({ root })
  assert.equal((await reloaded.load()).length, 1)
})

test('reads before load fail loud rather than reporting no worktrees', async () => {
  const store = createAnchorStore({ root })
  assert.throws(() => store.list(), /before load/)
})
