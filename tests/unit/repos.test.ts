/**
 * The repository store is the middle layer of the management tree, so its
 * cases are about what a user registered and what must never be invented: a
 * name they did not choose, a record that outlived its machine, or a
 * registration whose save failed but which still lists.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoStore, defaultRepoName } from '../../src/repos/store.ts'
import { asNodeId } from '../../src/ids.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drw-repos-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const fileIn = (name = 'repos.json'): string => join(dir, name)

test('a missing document loads as an empty store', async () => {
  const store = createRepoStore({ file: fileIn() })
  assert.deepEqual(await store.load(), [])
  assert.deepEqual(store.list(), [])
})

test('a path names a repository no caller named', async () => {
  assert.equal(defaultRepoName('/workspace/ACM-notes'), 'ACM-notes')
  assert.equal(defaultRepoName('/workspace/ACM-notes/'), 'ACM-notes')
  assert.equal(defaultRepoName('/srv'), 'srv')
})

test('registration derives the name, persists, and survives a reload', async () => {
  const file = fileIn()
  const first = createRepoStore({ file })
  await first.load()
  const stored = await first.upsert({ nodeId: asNodeId('node-1'), repoPath: '/workspace/ACM-notes' })

  assert.match(stored.repoId, /^[0-9a-f-]{36}$/)
  assert.equal(stored.name, 'ACM-notes')
  assert.equal(stored.nodeId, 'node-1')

  const second = createRepoStore({ file })
  assert.deepEqual(await second.load(), [stored])
})

test('a chosen name overrides the derived one and blank falls back', async () => {
  const store = createRepoStore({ file: fileIn() })
  await store.load()
  const named = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a', name: '  api  ' })
  assert.equal(named.name, 'api')

  const blank = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/b', name: '   ' })
  assert.equal(blank.name, 'b')
})

test('re-registering an existing id updates in place and keeps createdAt', async () => {
  let tick = 0
  const store = createRepoStore({
    file: fileIn(),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  })
  await store.load()
  const created = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a' })
  const updated = await store.upsert({ repoId: created.repoId, nodeId: asNodeId('n'), repoPath: '/srv/b' })

  assert.equal(updated.repoId, created.repoId)
  assert.equal(updated.repoPath, '/srv/b')
  assert.equal(updated.name, 'b')
  assert.equal(updated.createdAt, created.createdAt)
  assert.equal(store.list().length, 1)
})

test('an idempotent re-registration keeps the name the user chose', async () => {
  const store = createRepoStore({ file: fileIn() })
  await store.load()
  const created = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a', name: 'api' })
  const again = await store.upsert({ repoId: created.repoId, nodeId: asNodeId('n'), repoPath: '/srv/a' })

  assert.equal(again.name, 'api')
  assert.equal(again.repoId, created.repoId)
})

test('find resolves one machine path and ignores another machine', async () => {
  const store = createRepoStore({ file: fileIn() })
  await store.load()
  const stored = await store.upsert({ nodeId: asNodeId('node-1'), repoPath: '/srv/a' })

  assert.equal(store.find({ nodeId: asNodeId('node-1'), repoPath: '/srv/a' })?.repoId, stored.repoId)
  assert.equal(store.find({ nodeId: asNodeId('node-2'), repoPath: '/srv/a' }), undefined)
  assert.equal(store.find({ nodeId: asNodeId('node-1'), repoPath: '/srv/b' }), undefined)
})

test('remove drops exactly one repository and reports whether it existed', async () => {
  const store = createRepoStore({ file: fileIn() })
  await store.load()
  const kept = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a' })
  const dropped = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/b' })

  assert.equal(await store.remove(dropped.repoId), true)
  assert.equal(await store.remove(dropped.repoId), false)
  assert.deepEqual(store.list(), [kept])
})

test('removing a machine drops every repository of that machine alone', async () => {
  const file = fileIn()
  const store = createRepoStore({ file })
  await store.load()
  await store.upsert({ nodeId: asNodeId('node-1'), repoPath: '/srv/a' })
  await store.upsert({ nodeId: asNodeId('node-1'), repoPath: '/srv/b' })
  const other = await store.upsert({ nodeId: asNodeId('node-2'), repoPath: '/srv/a' })

  assert.equal(await store.removeByNode(asNodeId('node-1')), 2)
  assert.equal(await store.removeByNode(asNodeId('node-1')), 0)
  assert.deepEqual(store.list(), [other])
  assert.equal(JSON.parse(await readFile(file, 'utf8')).repos.length, 1)
})

test('the first write seeds a missing document directory', async () => {
  const file = join(dir, 'absent', 'deeper', 'repos.json')
  const store = createRepoStore({ file })
  await store.load()
  const stored = await store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a' })

  const reloaded = createRepoStore({ file })
  assert.deepEqual(await reloaded.load(), [stored])
})

test('a failed save leaves the store reporting what is on disk', async () => {
  const file = fileIn()
  await mkdir(`${file}.lock`, { recursive: true })
  const store = createRepoStore({ file })
  await store.load()

  await assert.rejects(() => store.upsert({ nodeId: asNodeId('n'), repoPath: '/srv/a' }))
  assert.deepEqual(store.list(), [])
})

test('a malformed document fails loud instead of loading as empty', async () => {
  const file = fileIn()
  await writeFile(file, '{ not json', 'utf8')
  const store = createRepoStore({ file })
  await assert.rejects(() => store.load(), /not valid JSON/)
})

test('a document from another build version is refused', async () => {
  const file = fileIn()
  await writeFile(file, JSON.stringify({ version: 99, repos: [] }), 'utf8')
  const store = createRepoStore({ file })
  await assert.rejects(() => store.load(), /version 99/)
})

test('a record the build does not understand is refused', async () => {
  const file = fileIn()
  await writeFile(file, JSON.stringify({ version: 1, repos: [{ nodeId: asNodeId('n') }] }), 'utf8')
  const store = createRepoStore({ file })
  await assert.rejects(() => store.load(), /does not understand/)
})

test('reads before load fail loud rather than reporting an empty install', async () => {
  const store = createRepoStore({ file: fileIn() })
  assert.throws(() => store.list(), /before load/)
})
