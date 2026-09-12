/**
 * The startup pass is the only thing that connects a machine without a person
 * asking, so its cases are about how far it goes and when it stops: it retries
 * a failure a bounded number of times, one unreachable machine does not delay
 * or stop the others, and disposal cancels what has not started.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NodeConnections } from '../../src/nodes/connections.ts'
import type { NodeRecord } from '../../src/storage/nodes.ts'
import { autoconnect } from '../../src/nodes/autoconnect.ts'
import { asNodeId } from '../../src/ids.ts'

/** A machine record, as the registry would hand one over. */
function record(nodeId: string): NodeRecord {
  return {
    nodeId: asNodeId(nodeId),
    title: nodeId,
    token: 't',
    transport: { kind: 'direct', host: '127.0.0.1', port: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * A connection manager driven by a script of permitted failures.
 *
 * An entry is how many attempts may fail before the machine answers; a machine
 * the script does not mention never answers, which is what an unreachable one
 * looks like from here.
 */
function connectionsOf(script: Readonly<Record<string, number>>) {
  const attempts: string[] = []
  const connections = {
    connect: (entry: NodeRecord) => {
      attempts.push(entry.nodeId)
      const permitted = script[entry.nodeId] ?? Number.POSITIVE_INFINITY
      const seen = attempts.filter(nodeId => nodeId === entry.nodeId).length
      return seen > permitted
        ? Promise.resolve({} as never)
        : Promise.reject(new Error(`"${entry.nodeId}" is unreachable`))
    },
  } as unknown as Pick<NodeConnections, 'connect'>
  return { attempts, connections }
}

/** A delay that records its gaps instead of waiting. */
function gaps(): { waits: number[]; delay: (ms: number) => Promise<void> } {
  const waits: number[] = []
  return { waits, delay: (ms: number) => { waits.push(ms); return Promise.resolve() } }
}

test('a machine that connects on the first attempt is attempted once', async () => {
  const { attempts, connections } = connectionsOf({ n1: 0 })
  const { waits, delay } = gaps()

  autoconnect({ records: () => [record('n1')], connections, delay })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, ['n1'])
  assert.deepEqual(waits, [], 'a machine that connects is never paused over')
})

test('a machine that keeps failing is attempted a bounded number of times', async () => {
  const { attempts, connections } = connectionsOf({})
  const { waits, delay } = gaps()

  autoconnect({ records: () => [record('n1')], connections, attempts: 3, gapMs: 5, delay })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, ['n1', 'n1', 'n1'])
  assert.deepEqual(waits, [5, 5], 'the gap comes before every attempt but the first')
})

test('a machine that fails twice and then answers is left connected', async () => {
  const { attempts, connections } = connectionsOf({ n1: 2 })
  const { delay } = gaps()

  autoconnect({ records: () => [record('n1')], connections, attempts: 5, delay })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, ['n1', 'n1', 'n1'], 'the pass stops at the first success')
})

test('one unreachable machine does not hold up the others', async () => {
  const { attempts, connections } = connectionsOf({ n2: 0 })
  const { delay } = gaps()

  autoconnect({ records: () => [record('n1'), record('n2')], connections, attempts: 2, delay })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, ['n1', 'n2', 'n1'], 'both machines are attempted in parallel')
})

test('stopping the pass cancels the attempts still to come', async () => {
  const { attempts, connections } = connectionsOf({})
  // A gap that never ends until the test releases it, so the pass is provably
  // between attempts when the stop arrives.
  const held: (() => void)[] = []
  const delay = (): Promise<void> => new Promise(resolve => { held.push(resolve) })

  const stop = autoconnect({ records: () => [record('n1')], connections, attempts: 5, delay })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempts, ['n1'])

  stop()
  held.forEach(release => { release() })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, ['n1'], 'the stopped pass never tries again')
})

test('a deployment with no machines starts no attempts', async () => {
  const { attempts, connections } = connectionsOf({})

  autoconnect({ records: () => [], connections })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(attempts, [])
})
