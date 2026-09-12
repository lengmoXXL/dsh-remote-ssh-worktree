/**
 * The end-to-end path this plugin exists for: a real daemon on a real socket,
 * a real handshake, and the routing filesystem serving a remote anchor over
 * the wire.
 *
 * Nothing is stubbed except the local delegate, which throws when touched —
 * that is deliberate, because it proves the remote branch never falls back to
 * the local world.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import { AGENT_VERSION } from '../../src/nodes/agent/install.ts'
import { connectNode } from '../../src/nodes/client.ts'
import type { ConnectedNode } from '../../src/nodes/client.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingFileSystem } from '../../src/plugin/routing/fs.ts'
import { asNodeId } from '../../src/ids.ts'

const TOKEN = 'test-token-0123456789'

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode

/** A local delegate that fails loudly if the remote branch ever reaches it. */
const localDelegate = new Proxy({}, {
  get(_target, property) {
    if (property === 'sandboxMode') return undefined
    return () => {
      throw new Error(`the local delegate was reached for "${String(property)}"`)
    }
  },
}) as unknown as FileSystem

/** A routing filesystem whose only anchor is the daemon's root. */
function router(anchors: readonly AnchorRoute[]) {
  return createRoutingFileSystem({
    localFs: localDelegate,
    anchors: () => anchors,
    channel: nodeId => (nodeId === 'n1' ? node.channel : undefined),
  })
}

/** The single anchor this suite configures. */
function baseAnchors(): AnchorRoute[] {
  return [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
}

before(async () => {
  // The daemon canonicalizes every path it answers with, and on macOS a temp
  // directory is reached through a symlinked `/var`, so the local spelling and
  // the canonical one differ. Realpath here so expectations compare canonical
  // to canonical.
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-e2e-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-e2e-anchor-')))
  await writeFile(join(remoteRoot, 'hello.txt'), 'hello from the node\n', 'utf8')
  await mkdir(join(remoteRoot, 'sub'))
  await writeFile(join(remoteRoot, 'sub', 'nested.txt'), 'nested\n', 'utf8')

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(remoteRoot, { recursive: true, force: true })
  await rm(anchorRoot, { recursive: true, force: true })
})

test('the handshake reports the protocol revision and capabilities', () => {
  assert.equal(node.info.protocol, 1)
  assert.equal(node.info.agentVersion, AGENT_VERSION)
  assert.equal(typeof node.info.platform, 'string')
  // The handshake reports which capabilities exist; the terminal tests pin
  // the terminal one, so this only asserts that the daemon answered the field.
  assert.equal(typeof node.info.capability.pty, 'boolean')
})

test('an anchor path routes to the node and maps onto the remote root', async () => {
  const target = await router(baseAnchors()).resolve(join(anchorRoot, 'hello.txt'))
  assert.equal(target.displayPath, join(remoteRoot, 'hello.txt'))
  assert.match(String(target.targetKey), /^node:n1:/)
})

test('reading a remote file returns the node content', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'hello.txt'))
  assert.equal(await fs.readText(target), 'hello from the node\n')
})

test('the remote root spelling of the same file resolves to the same target', async () => {
  const fs = router(baseAnchors())
  const viaAnchor = await fs.resolve(join(anchorRoot, 'hello.txt'))
  const viaRemote = await fs.resolve(join(remoteRoot, 'hello.txt'))
  assert.equal(viaRemote.targetKey, viaAnchor.targetKey)
})

test('listing a remote directory reports children with remote targets', async () => {
  const fs = router(baseAnchors())
  const dir = await fs.resolve(anchorRoot)
  const entries = await fs.listDir(dir)
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['hello.txt', 'sub'])

  const sub = entries.find(entry => entry.name === 'sub')
  assert.equal(sub?.type, 'directory')
  assert.equal(sub?.target.displayPath, join(remoteRoot, 'sub'))
})

test('a guarded remote write lands on the node and returns the seam outcome', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'created.txt'))
  const outcome = await fs.writeText(target, 'written remotely\n', { kind: 'createIfAbsent' })

  assert.equal(outcome.operation, 'create')
  assert.equal(outcome.before, null)
  assert.equal(outcome.after, 'written remotely\n')
  assert.equal(await readFile(join(remoteRoot, 'created.txt'), 'utf8'), 'written remotely\n')
})

test('a stale remote write is refused with the seam code', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'hello.txt'))
  await assert.rejects(
    () => fs.writeText(target, 'clobber', { kind: 'replaceIfVersion', version: 'not-the-version' as never }),
    (error: unknown) => (error as { code?: string }).code === 'FS_STALE_VERSION',
  )
})

test('a remote edit applies the literal replacement', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'hello.txt'))
  const outcome = await fs.editText(target, {
    oldString: 'hello',
    newString: 'goodbye',
    replaceAll: false,
  })

  assert.equal(outcome.before, 'hello from the node\n')
  assert.equal(outcome.after, 'goodbye from the node\n')
  assert.equal(await readFile(join(remoteRoot, 'hello.txt'), 'utf8'), 'goodbye from the node\n')
})

test('a byte window reads only what was asked for', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'hello.txt'))
  const window = await fs.readByteRange(target, { offset: 8, length: 4 })
  assert.equal(Buffer.from(window).toString('utf8'), 'from')
})

test('stat reports a version a later write accepts', async () => {
  const fs = router(baseAnchors())
  const target = await fs.resolve(join(anchorRoot, 'created.txt'))
  const info = await fs.stat(target)
  assert.equal(info?.type, 'file')

  const outcome = await fs.writeText(
    target,
    'second\n',
    { kind: 'replaceIfVersion', version: info!.version },
  )
  assert.equal(outcome.operation, 'update')
  assert.equal(outcome.before, 'written remotely\n')
})

test('an ambiguous remote path is refused instead of picking a node', async () => {
  const anchors: AnchorRoute[] = [
    { nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot },
    { nodeId: asNodeId('n2'), anchorPath: join(anchorRoot, 'other'), remoteRoot },
  ]
  await assert.rejects(
    () => router(anchors).resolve(join(remoteRoot, 'hello.txt')),
    /more than one node/,
  )
})

test('a path on a disconnected node fails with a typed error, never locally', async () => {
  const offline = createRoutingFileSystem({
    localFs: localDelegate,
    anchors: () => baseAnchors(),
    channel: () => undefined,
  })
  await assert.rejects(
    () => offline.resolve(join(anchorRoot, 'hello.txt')),
    /is not connected/,
  )
})

test('a wrong token is refused at the handshake', async () => {
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  await assert.rejects(
    () => connectNode({ host: '127.0.0.1', port, token: 'wrong', timeoutMs: 5_000 }),
  )
})
