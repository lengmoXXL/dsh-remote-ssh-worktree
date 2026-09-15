/**
 * The terminal registry's own decisions, away from any socket or tool: who may
 * address a terminal, what attach and detach forward, how the byte ring stays
 * accountable, what a key name means, and what an exited terminal reports.
 *
 * The seam is faked at its boundary, so every case here is about the table's
 * contract rather than about a PTY.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../../src/tty.ts'
import {
  createTerminalRegistry,
  TerminalRegistryError,
  type TerminalRegistry,
  type TerminalSettings,
  type TerminalSink,
} from '../../src/terminal/host/registry.ts'

/** How the registry starts a shell, for every case below. */
const settings: TerminalSettings = {
  shell: '/bin/sh',
  shellArgs: ['-l'],
  env: { TERM: 'xterm-256color' },
  graceMs: 1000,
}

/** One terminal the seam handed back, with the knobs a case drives. */
interface FakeTerminal {
  readonly handle: TtyHandle
  readonly writes: string[]
  readonly resizes: number[][]
  terminations(): number
  emit(chunk: Buffer | string): void
  exit(outcome: TtyOutcome): void
}

/**
 * A terminal handle a case answers for.
 * @returns the handle and the observations a case makes on it.
 */
function fakeTerminal(): FakeTerminal {
  const output = new PassThrough()
  const writes: string[] = []
  const resizes: number[][] = []
  let terminations = 0
  let settle: (outcome: TtyOutcome) => void = () => {}
  const done = new Promise<TtyOutcome>((resolve) => { settle = resolve })
  return {
    writes,
    resizes,
    terminations: () => terminations,
    emit: (chunk) => { output.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk) },
    exit: outcome => settle(outcome),
    handle: {
      pid: 4242,
      output,
      done,
      async write(data) { writes.push(data) },
      async resize(cols, rows) { resizes.push([cols, rows]) },
      async terminate() { terminations += 1 },
    },
  }
}

/** A registry over one fake provider. */
function harness(): { registry: TerminalRegistry; terminal: FakeTerminal; requests: TtySpawnRequest[] } {
  const terminal = fakeTerminal()
  const requests: TtySpawnRequest[] = []
  const registry = createTerminalRegistry({
    spawn: async (request) => {
      requests.push(request)
      return terminal.handle
    },
    settings,
    machine: () => ({ nodeId: 'local', label: 'Local' }),
  })
  return { registry, terminal, requests }
}

/** A sink that records what the registry forwards. */
function recorder(): TerminalSink & { readonly chunks: string[]; readonly exits: TtyOutcome[] } {
  const chunks: string[] = []
  const exits: TtyOutcome[] = []
  return {
    chunks,
    exits,
    output(chunk) { chunks.push(chunk.toString('utf8')) },
    exit(outcome) { exits.push(outcome) },
    fail() {},
  }
}

/** Let the pump's asynchronous forwarding run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('a terminal is spawned through the seam and listed with its geometry', async () => {
  const { registry, requests } = harness()
  const entry = await registry.open('s1', '/w/live', { cols: 120, rows: 40 })

  assert.deepEqual(requests, [{
    argv: ['/bin/sh', '-l'],
    cwd: '/w/live',
    env: { TERM: 'xterm-256color' },
    cols: 120,
    rows: 40,
    graceMs: 1000,
  }])
  assert.equal(entry.id, 't1')
  assert.deepEqual(registry.listFor('s1'), [{
    id: 't1',
    label: 'Terminal 1',
    cwd: '/w/live',
    machine: 'Local',
    pid: 4242,
    state: 'running',
    cols: 120,
    rows: 40,
  }])
})

test('another Session cannot address a terminal, and the refusal does not name it as someone else’s', async () => {
  const { registry } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  await registry.open('s2', '/w/b', { cols: 80, rows: 24 })

  assert.throws(() => registry.requireOwned('s2', 't1'), (error: unknown) => {
    assert.ok(error instanceof TerminalRegistryError)
    assert.match((error as Error).message, /no terminal "t1" is open in this session/)
    return true
  })
  // The caller's own terminal is addressable, and the list is scoped to it.
  assert.equal(registry.requireOwned('s2', 't2').id, 't2')
  assert.deepEqual(registry.listFor('s2').map(view => view.id), ['t2'])
})

test('a Session with no terminal, and one with several, are told exactly what to do', async () => {
  const { registry } = harness()
  assert.throws(() => registry.requireOwned('s1'), /this session has no open terminal/)

  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  assert.equal(registry.requireOwned('s1').id, 't1')

  await registry.open('s1', '/w/b', { cols: 80, rows: 24 })
  assert.throws(() => registry.requireOwned('s1'), /pass "terminal" with one of: t1 \(Terminal 1\), t2 \(Terminal 2\)/)

  // A named terminal with several open is unambiguous.
  assert.equal(registry.requireOwned('s1', 't2').id, 't2')
  assert.throws(() => registry.requireOwned('s1', 't9'), /no terminal "t9" is open in this session/)
})

test('attach forwards output produced while attached and detach stops it', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const sink = recorder()

  registry.attach('t1', sink)
  terminal.emit('before\n')
  await settle()
  registry.detach('t1', sink)
  terminal.emit('after\n')
  await settle()

  assert.deepEqual(sink.chunks, ['before\n'])
  // Detaching stops delivery, not the terminal: the output is still retained.
  assert.match(registry.read('t1').text, /before\nafter\n/)
})

test('the ring buffer drops the oldest bytes and keeps offsets accountable', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const cap = 256 * 1024

  terminal.emit(Buffer.alloc(cap + 4096, 0x61))
  const entry = registry.requireOwned('s1', 't1')
  assert.equal(entry.bytes, cap + 4096)
  assert.equal(entry.buffer.length, cap)
  assert.equal(entry.dropped, 4096)

  // An offset inside the dropped region is clamped to the oldest retained byte
  // and reported as truncated rather than silently reading the wrong bytes.
  const lost = registry.read('t1', 0)
  assert.equal(lost.truncated, true)
  assert.equal(lost.text.length, cap)
  assert.equal(lost.offset, cap + 4096)

  const exact = registry.read('t1', entry.dropped)
  assert.equal(exact.truncated, false)
  assert.equal(exact.text.length, cap)

  terminal.emit('tail')
  const latest = registry.read('t1', cap + 4096)
  assert.equal(latest.truncated, false)
  assert.equal(latest.text, 'tail')
  assert.equal(latest.offset, cap + 4096 + 4)
})

test('a read keeps the requested tail line count', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  terminal.emit('l1\nl2\nl3')

  assert.equal(registry.read('t1', undefined, 2).text, 'l2\nl3')
  assert.equal(registry.read('t1', undefined, 2).truncated, true)
  assert.equal(registry.read('t1', undefined, 5).text, 'l1\nl2\nl3')
  assert.equal(registry.read('t1', undefined, 5).truncated, false)
})

test('every logical key resolves to its bytes, and an unknown one writes nothing', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  const wrote = await registry.keys('t1', ['up', 'ctrl+c', 'enter'])
  assert.deepEqual(terminal.writes, ['\x1b[A\x03\r'])
  assert.equal(wrote.keys, 3)
  assert.equal(wrote.bytes, 5)

  await assert.rejects(registry.keys('t1', ['tab', 'nosuchkey']), (error: unknown) => {
    assert.match((error as Error).message, /unknown key "nosuchkey"/)
    assert.match((error as Error).message, /known keys are enter/)
    return true
  })
  // The whole call failed before a byte was written, so the first key did not
  // arrive either.
  assert.deepEqual(terminal.writes, ['\x1b[A\x03\r'])
})

test('an exited terminal reports its exit and refuses further operations', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const sink = recorder()
  registry.attach('t1', sink)

  terminal.exit({ exitCode: 0, signal: null })
  await settle()

  assert.deepEqual(sink.exits, [{ exitCode: 0, signal: null }])
  assert.equal(registry.listFor('s1')[0]?.state, 'exited')
  assert.throws(() => registry.requireOwned('s1', 't1'), /has already exited/)
  await assert.rejects(registry.write('t1', 'x'), /has already exited/)
})

test('a release terminates the terminal and removes it from the list', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  await registry.kill('t1')

  assert.equal(terminal.terminations(), 1)
  assert.deepEqual(registry.listFor('s1'), [])
  assert.throws(() => registry.requireOwned('s1'), /this session has no open terminal/)
})

test('a Session ending releases exactly its own terminals', async () => {
  const { registry } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  await registry.open('s2', '/w/b', { cols: 80, rows: 24 })

  await registry.releaseSession('s1')

  assert.deepEqual(registry.listFor('s1'), [])
  assert.deepEqual(registry.listFor('s2').map(view => view.id), ['t2'])
})

test('writes keep the order they were issued in', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  const first = registry.write('t1', 'one')
  const second = registry.write('t1', 'two')
  const third = registry.write('t1', 'three')
  await Promise.all([first, second, third])

  assert.deepEqual(terminal.writes, ['one', 'two', 'three'])
})

test('resize reports the provider’s answer without changing the terminal state', async () => {
  const { registry, terminal } = harness()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  assert.equal(await registry.resize('t1', 100, 30), true)
  assert.deepEqual(terminal.resizes, [[100, 30]])
  assert.equal(registry.listFor('s1')[0]?.cols, 100)
  assert.equal(registry.listFor('s1')[0]?.rows, 30)
})
