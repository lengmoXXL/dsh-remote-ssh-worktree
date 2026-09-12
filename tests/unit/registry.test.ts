/**
 * The node registry is the durable half of the management surface, so its
 * cases are about what survives a restart and what must never be silently
 * tolerated: a document this build cannot read is a failure, not an empty
 * install, because starting empty would strand every workspace anchored to a
 * node that is still on disk.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeRegistry, toNodeView } from '../../src/nodes/registry.ts'
import type { NodeTransport } from '../../src/nodes/registry.ts'
import { asNodeId } from '../../src/ids.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drw-registry-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const fileIn = (name = 'nodes.json'): string => join(dir, name)

/** A stored machine reached at a fixed address, which the store treats like any other. */
const direct = (host: string, port = 7801): NodeTransport => ({ kind: 'direct', host, port })

test('a missing document loads as an empty registry', async () => {
  const registry = createNodeRegistry({ file: fileIn() })
  assert.deepEqual(await registry.load(), [])
  assert.deepEqual(registry.list(), [])
})

test('upsert generates an id, persists, and survives a reload', async () => {
  const file = fileIn()
  const first = createNodeRegistry({ file })
  await first.load()
  const stored = await first.upsert({ transport: direct('build-01'), token: 'secret' })

  assert.match(stored.nodeId, /^[0-9a-f-]{36}$/)
  assert.equal(stored.title, 'build-01:7801')
  assert.equal(stored.createdAt, stored.updatedAt)

  const second = createNodeRegistry({ file })
  assert.deepEqual(await second.load(), [stored])
})

test('upsert with an existing id updates in place and keeps createdAt', async () => {
  const file = fileIn()
  let tick = 0
  const registry = createNodeRegistry({
    file,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  })
  await registry.load()
  const created = await registry.upsert({ transport: direct('build-01'), token: 'one' })
  const updated = await registry.upsert({
    nodeId: created.nodeId,
    transport: { kind: 'direct', host: 'build-02', port: 7801 },
    token: 'two',
    title: 'Renamed',
  })

  assert.equal(registry.list().length, 1)
  assert.equal(updated.createdAt, created.createdAt)
  assert.notEqual(updated.updatedAt, created.updatedAt)
  assert.equal(updated.title, 'Renamed')
  assert.equal(updated.token, 'two')
})

test('remove drops exactly one node and reports whether it existed', async () => {
  const registry = createNodeRegistry({ file: fileIn() })
  await registry.load()
  const a = await registry.upsert({ transport: direct('a'), token: 't' })
  const b = await registry.upsert({ transport: direct('b'), token: 't' })

  assert.equal(await registry.remove(a.nodeId), true)
  assert.deepEqual(registry.list().map(node => node.nodeId), [b.nodeId])
  assert.equal(await registry.remove(a.nodeId), false)
})

test('the persisted document is owner-only, because it holds a secret', async () => {
  const file = fileIn()
  const registry = createNodeRegistry({ file })
  await registry.load()
  await registry.upsert({ transport: direct('a'), token: 'secret' })

  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('a malformed document fails loud instead of loading as empty', async () => {
  const file = fileIn()
  await writeFile(file, '{ not json', 'utf8')
  const registry = createNodeRegistry({ file })
  await assert.rejects(() => registry.load(), /not valid JSON/)
})

test('a document from another build version is refused', async () => {
  const file = fileIn()
  await writeFile(file, JSON.stringify({ version: 99, nodes: [] }), 'utf8')
  const registry = createNodeRegistry({ file })
  await assert.rejects(() => registry.load(), /document version 99/)
})

test('a record the build does not understand is refused', async () => {
  const file = fileIn()
  await writeFile(file, JSON.stringify({ version: 2, nodes: [{ nodeId: asNodeId('a') }] }), 'utf8')
  const registry = createNodeRegistry({ file })
  await assert.rejects(() => registry.load(), /does not understand/)
})

test('a revision-1 document carries over without losing its id', async () => {
  // Every repository and worktree already anchored to a node resolves by id,
  // so reading an older document must not renumber or drop a machine.
  const file = fileIn()
  await writeFile(file, JSON.stringify({
    version: 1,
    nodes: [{
      nodeId: asNodeId('kept-id'),
      title: 'build-01',
      host: '10.0.0.4',
      port: 7801,
      token: 'secret',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }), 'utf8')
  const registry = createNodeRegistry({ file })
  const [migrated] = await registry.load()

  assert.equal(migrated?.nodeId, 'kept-id')
  assert.equal(migrated?.title, 'build-01')
  assert.deepEqual(migrated?.transport, { kind: 'direct', host: '10.0.0.4', port: 7801 })
  assert.equal(migrated?.token, 'secret')
})

test('a revision-1 entry with no usable address is refused', async () => {
  const file = fileIn()
  await writeFile(file, JSON.stringify({ version: 1, nodes: [{ nodeId: asNodeId('a'), title: 'b' }] }), 'utf8')
  const registry = createNodeRegistry({ file })
  await assert.rejects(() => registry.load(), /revision 1/)
})

test('reads before load fail loud rather than reporting an empty install', async () => {
  const registry = createNodeRegistry({ file: fileIn() })
  assert.throws(() => registry.list(), /before load/)
})

test('the view drops the secret and keeps its presence', async () => {
  const registry = createNodeRegistry({ file: fileIn() })
  await registry.load()
  const record = await registry.upsert({ transport: direct('a'), token: 'secret' })
  const view = toNodeView(record)

  assert.equal(view.hasToken, true)
  assert.equal('token' in view, false)
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('the document keeps a trailing newline', async () => {
  const file = fileIn()
  const registry = createNodeRegistry({ file })
  await registry.load()
  await registry.upsert({ transport: direct('a'), token: 't' })
  assert.equal((await readFile(file, 'utf8')).endsWith('\n'), true)
})

test('the first write seeds a missing document directory', async () => {
  // The cross-process lock is a `wx` create that never makes its directory, so
  // a harness home that has never stored a node must not fail the first save.
  const file = join(dir, 'absent', 'deeper', 'nodes.json')
  const registry = createNodeRegistry({ file })
  await registry.load()
  const stored = await registry.upsert({ transport: direct('build-01'), token: 'secret' })

  const reloaded = createNodeRegistry({ file })
  assert.deepEqual(await reloaded.load(), [stored])
})

test('a failed save leaves the registry reporting what is on disk', async () => {
  // Commit before publishing: a save that throws must not leave the rejected
  // mutation in the list, or the next successful save silently commits it.
  const file = fileIn()
  await mkdir(`${file}.lock`, { recursive: true })
  const registry = createNodeRegistry({ file })
  await registry.load()

  await assert.rejects(() => registry.upsert({ transport: direct('phantom'), token: 'b' }))
  assert.deepEqual(registry.list(), [])
})
