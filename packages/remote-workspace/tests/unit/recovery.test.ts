/**
 * A connection that drops has to come back on its own.
 *
 * The manager already notices a loss — a forward that closes publishes the
 * failure — but noticing is not recovering: with no retry the machine stays
 * failed until a person opens the section and clicks Connect, and a Session
 * whose workspace lives there stays unusable until they do.
 *
 * These cases drive the drop and the attempts through an injected transport and
 * connector, so nothing here needs a socket or a real gap.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { NodeInfo } from '../../src/remote/protocol.ts'
import { createNodeConnections } from '../../src/models/machines.ts'
import type { ResolvedTransport } from '../../src/models/machines.ts'
import type { NodeRecord } from '../../src/storage/nodes.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

const info: NodeInfo = {
  protocol: 1,
  agentVersion: '0.0.2',
  platform: 'linux',
  arch: 'x64',
  node: 'v22.19.0',
  homedir: '/home/dev',
  capability: { pty: true, spill: false, ripgrep: null },
}

const record: NodeRecord = {
  nodeId: asNodeId('n1'),
  title: 'build-01',
  transport: { kind: 'direct', host: 'build-01', port: 7801 },
  token: 'secret',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** A transport the case can drop, the way a forward or a link dies. */
type Droppable = ResolvedTransport & { drop(): void }

/**
 * One transport whose loss the case triggers by hand.
 * @returns the transport.
 */
function droppable(): Droppable {
  let drop: () => void = () => {}
  const exited = new Promise<void>((resolve) => { drop = resolve })
  return { host: '127.0.0.1', port: 7801, exited, close: () => {}, drop }
}

/** A connected node whose close() does nothing the case observes. */
function stubNode(): ConnectedNode {
  return {
    info,
    channel: { request: () => Promise.reject(new Error('not used')), onPipeFrame: () => () => {} },
    close: () => {},
  }
}

/**
 * Wait for a condition rather than for a fixed gap.
 * @param condition - what must hold.
 * @param timeoutMs - how long to wait before failing.
 */
async function until(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

test('a connection that drops is re-established without being asked', async () => {
  const opened: Droppable[] = []
  const connections = createNodeConnections({
    openTransport: () => {
      const transport = droppable()
      opened.push(transport)
      return Promise.resolve(transport)
    },
    connect: () => Promise.resolve(stubNode()),
    recoveryGapMs: 1,
  })

  await connections.connect(record)
  assert.equal(connections.status(asNodeId('n1')).state, 'ready')

  opened[0]!.drop()
  await until(() => opened.length === 2 && connections.status(asNodeId('n1')).state === 'ready')

  assert.notEqual(connections.channel(asNodeId('n1')), undefined, 'the recovered node is usable again')
})

test('recovery stops once its attempts are spent, leaving the failure readable', async () => {
  let opens = 0
  const first = droppable()
  const connections = createNodeConnections({
    openTransport: () => {
      opens += 1
      return opens === 1 ? Promise.resolve(first) : Promise.reject(new Error('ssh: connect refused'))
    },
    connect: () => Promise.resolve(stubNode()),
    recoveryAttempts: 2,
    recoveryGapMs: 1,
  })

  await connections.connect(record)
  first.drop()
  await until(() => opens === 3)
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(opens, 3, 'no further attempt runs after the last one')
  assert.equal(connections.status(asNodeId('n1')).state, 'failed')
  assert.match(String(connections.status(asNodeId('n1')).error), /connect refused/)
})

test('a machine a person disconnected stays down', async () => {
  let opens = 0
  const connections = createNodeConnections({
    openTransport: () => { opens += 1; return Promise.resolve(droppable()) },
    connect: () => Promise.resolve(stubNode()),
    recoveryGapMs: 1,
  })

  await connections.connect(record)
  connections.disconnect(asNodeId('n1'))
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(connections.status(asNodeId('n1')).state, 'disconnected')
  assert.equal(opens, 1, 'a deliberate disconnect is not undone')
})

test('disposing cancels a recovery that has not run yet', async () => {
  let opens = 0
  const first = droppable()
  const connections = createNodeConnections({
    openTransport: () => { opens += 1; return Promise.resolve(first) },
    connect: () => Promise.resolve(stubNode()),
    recoveryGapMs: 40,
  })

  await connections.connect(record)
  first.drop()
  await new Promise(resolve => setImmediate(resolve))
  connections.dispose()
  await new Promise(resolve => setTimeout(resolve, 80))

  assert.equal(opens, 1, 'nothing reconnects after the manager is disposed')
})
