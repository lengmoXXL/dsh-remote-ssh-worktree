/**
 * Behavior tests for the daemon's subprocess operations.
 *
 * Fixtures are real Node processes started from the test itself, so the
 * managed process group, the termination ladder, and the byte-exact collected
 * output are all observed against the operating system rather than a stub.
 *
 * @module dsh-remote-agent/tests/subprocess
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { SpPipeFrame, WireOutcome, WireSpawnSpec } from '../../shared/protocol.ts'
import type { SubprocessBackend } from '../src/subprocess.ts'
import { SubprocessFailure } from '../src/execution.ts'
import { MAX_PIPE_BACKLOG_FRAMES, createSubprocessBackend } from '../src/subprocess.ts'

/** Poll interval while waiting for a fixture to reach a state. */
const POLL_MS = 20

/** Give up on a fixture after this long. */
const DEADLINE_MS = 10_000

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Poll `probe` until it answers, or fail once the deadline passes. */
async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > DEADLINE_MS) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_MS)
  }
}

/** Whether a pid still exists (a zombie counts until it is reaped). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Run an operation expected to fail and return its protocol code. */
async function failureCode(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    assert.ok(error instanceof SubprocessFailure, `expected SubprocessFailure, got ${String(error)}`)
    return error.code
  }
  throw new Error('expected the operation to fail')
}

describe('subprocess backend', () => {
  let dir: string
  let sp: SubprocessBackend
  let frames: SpPipeFrame[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-sp-'))
    frames = []
    // The recording sender plays the connection's role: every piped chunk
    // arrives here exactly as the daemon would push it.
    sp = createSubprocessBackend(async (frame) => { frames.push(frame) })
  })

  afterEach(async () => {
    sp.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** A spawn request with collected streams, overridden per test. */
  function spec(argv: readonly string[], overrides: Partial<WireSpawnSpec> = {}): WireSpawnSpec {
    return {
      argv,
      cwd: dir,
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
      graceMs: 500,
      ...overrides,
    }
  }

  /** Wait until the child closed, so every collected byte is already buffered. */
  async function awaitClose(procId: string): Promise<WireOutcome> {
    return await until(() => sp.outcome(procId) ?? undefined, `process ${procId} to close`)
  }

  /** The bytes one collected stream holds from the beginning. */
  function bytesOf(procId: string, stream: 'stdout' | 'stderr' = 'stdout'): Buffer {
    return Buffer.from(sp.readOutput(procId, stream, 0).data, 'base64')
  }

  /** The frames one piped stream published, in arrival order. */
  function framesFor(procId: string, stream: 'stdout' | 'stderr'): SpPipeFrame[] {
    return frames.filter(frame => frame.procId === procId && frame.stream === stream)
  }

  /** The bytes the frames of one piped stream reassemble to. */
  function pipedBytes(procId: string, stream: 'stdout' | 'stderr'): Buffer {
    return Buffer.concat(framesFor(procId, stream).map(frame => Buffer.from(frame.data, 'base64')))
  }

  it('resolves a bare name on PATH and refuses what it cannot run', async () => {
    const resolved = await sp.resolveExecutable('sh', undefined)
    assert.ok(resolved.path.startsWith('/'), `${resolved.path} is not absolute`)
    assert.equal(resolved.path, await realpath(resolved.path))
    assert.equal((await sp.resolveExecutable(process.execPath, undefined)).path, await realpath(process.execPath))

    assert.equal(
      await failureCode(() => sp.resolveExecutable('definitely-not-a-command-xyz', undefined)),
      'SP_NOT_FOUND',
    )
    assert.equal(await failureCode(() => sp.resolveExecutable('./sh', undefined)), 'SP_NOT_EXECUTABLE')
    assert.equal(
      await failureCode(() => sp.resolveExecutable(join(dir, 'missing'), undefined)),
      'SP_NOT_FOUND',
    )

    const plain = join(dir, 'not-executable')
    await writeFile(plain, 'data\n', { mode: 0o644 })
    assert.equal(await failureCode(() => sp.resolveExecutable(plain, undefined)), 'SP_NOT_EXECUTABLE')

    // The caller's PATH overlay decides the search, not the daemon's own.
    const tool = join(dir, 'local-tool')
    await writeFile(tool, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    assert.equal((await sp.resolveExecutable('local-tool', { PATH: dir })).path, await realpath(tool))
    assert.equal(await failureCode(() => sp.resolveExecutable('local-tool', { PATH: '/nonexistent' })), 'SP_NOT_FOUND')
  })

  it('feeds batch stdin and reads the echoed bytes back', async () => {
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      { stdin: { data: 'hello from stdin\n' } },
    ))
    await sp.waitForExit(procId)
    assert.deepEqual(await awaitClose(procId), { exitCode: 0, signal: null })
    assert.equal(bytesOf(procId).toString('utf8'), 'hello from stdin\n')
  })

  it('writes and closes a piped stdin', async () => {
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      { stdin: 'pipe' },
    ))
    sp.writeStdin(procId, 'piped\n')
    sp.closeStdin(procId)
    await sp.waitForExit(procId)
    await awaitClose(procId)
    assert.equal(bytesOf(procId).toString('utf8'), 'piped\n')
  })

  it('serves two independent readers the same bytes from offset zero', async () => {
    const { procId } = await sp.spawn(spec([process.execPath, '-e', "process.stdout.write('abcdefghij')"]))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const first = sp.readOutput(procId, 'stdout', 0)
    const second = sp.readOutput(procId, 'stdout', 0)
    assert.equal(second.data, first.data)
    assert.equal(second.nextOffset, first.nextOffset)
    assert.equal(Buffer.from(first.data, 'base64').toString('utf8'), 'abcdefghij')
    assert.equal(first.nextOffset, 10)
    assert.equal(first.lossy, false)
  })

  it('returns raw bytes without decoding or normalizing anything', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    const script = `process.stdout.write(Buffer.from([${[...raw].join(',')}]))`
    const { procId } = await sp.spawn(spec([process.execPath, '-e', script]))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const read = sp.readOutput(procId, 'stdout', 0)
    assert.deepEqual(Buffer.from(read.data, 'base64'), raw)
    assert.equal(read.nextOffset, raw.length)
  })

  it('keeps the tail and reports a read whose offset slid out of the window', async () => {
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(5000))"],
      { stdout: { maxBytes: 1000 } },
    ))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const lossy = sp.readOutput(procId, 'stdout', 0)
    assert.equal(lossy.lossy, true)
    assert.equal(lossy.nextOffset, 5000)
    const tail = Buffer.from(lossy.data, 'base64')
    assert.equal(tail.length, 1000)
    assert.equal(tail.toString('utf8'), 'x'.repeat(1000))

    const retainedStart = sp.readOutput(procId, 'stdout', 4000)
    assert.equal(retainedStart.lossy, false)
    assert.equal(Buffer.from(retainedStart.data, 'base64').length, 1000)
  })

  it('reports outcome as null while running and the exit facts after', async () => {
    const { procId } = await sp.spawn(spec([process.execPath, '-e', 'setTimeout(() => process.exit(7), 400)']))
    assert.equal(sp.outcome(procId), null)
    await sp.waitForExit(procId)
    assert.deepEqual(await awaitClose(procId), { exitCode: 7, signal: null })
  })

  it('refuses stdin writes when the process was started without a pipe', async () => {
    const { procId } = await sp.spawn(spec([process.execPath, '-e', 'setTimeout(() => {}, 500)']))
    assert.equal(await failureCode(() => sp.writeStdin(procId, 'x')), 'SP_UNSUPPORTED_STDIO')
    assert.equal(await failureCode(() => sp.closeStdin(procId)), 'SP_UNSUPPORTED_STDIO')
  })

  it('reports an unknown process for every method that addresses one', async () => {
    assert.equal(await failureCode(() => sp.readOutput('nope', 'stdout', 0)), 'SP_NO_SUCH_PROCESS')
    assert.equal(await failureCode(() => sp.writeStdin('nope', 'x')), 'SP_NO_SUCH_PROCESS')
    assert.equal(await failureCode(() => sp.terminate('nope')), 'SP_NO_SUCH_PROCESS')
    assert.equal(await failureCode(() => sp.waitForExit('nope')), 'SP_NO_SUCH_PROCESS')
    assert.equal(await failureCode(() => sp.outcome('nope')), 'SP_NO_SUCH_PROCESS')
  })

  it('refuses a working directory that does not exist', async () => {
    assert.equal(
      await failureCode(() => sp.spawn(spec([process.execPath, '-e', ''], { cwd: join(dir, 'missing') }))),
      'SP_SPAWN_FAILED',
    )
    assert.equal(
      await failureCode(() => sp.spawn(spec([process.execPath, '-e', ''], { cwd: 'relative' }))),
      'SP_SPAWN_FAILED',
    )
    assert.equal(
      await failureCode(() => sp.spawn(spec([join(dir, 'no-such-program')]))),
      'SP_SPAWN_FAILED',
    )
  })

  it('escalates to SIGKILL and waits for the whole process group', async () => {
    // The grandchild outlives nothing: both it and its parent ignore SIGTERM,
    // so only a group-wide SIGKILL after the grace can end the range.
    await writeFile(join(dir, 'grandchild.cjs'), [
      "require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid))",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'parent.cjs'), [
      "require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], { stdio: 'ignore', cwd: __dirname })",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    const pidFile = join(dir, 'grandchild.pid')

    const { procId } = await sp.spawn(spec([process.execPath, 'parent.cjs'], {
      graceMs: 300,
      env: { PID_FILE: pidFile },
    }))
    const grandchildPid = await until(() => {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8'))
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
      } catch {
        return undefined
      }
    }, 'the grandchild to start')
    assert.equal(isAlive(grandchildPid), true)

    const startedAt = Date.now()
    sp.terminate(procId)
    sp.terminate(procId)
    await sp.waitForExit(procId)
    assert.ok(Date.now() - startedAt >= 300, 'the ladder killed before its grace elapsed')

    await until(() => (isAlive(grandchildPid) ? undefined : true), 'the grandchild to disappear')
    assert.deepEqual(await awaitClose(procId), { exitCode: null, signal: 'SIGKILL' })
  })

  it('collects with a spill cap without changing what a reader sees', async () => {
    const under = await sp.spawn(spec(
      [process.execPath, '-e', "process.stdout.write('y'.repeat(256))"],
      { stdout: { maxBytes: 64, spillMaxBytes: 4096 } },
    ))
    await sp.waitForExit(under.procId)
    await awaitClose(under.procId)
    const underRead = sp.readOutput(under.procId, 'stdout', 0)
    assert.equal(underRead.lossy, true)
    assert.equal(Buffer.from(underRead.data, 'base64').length, 64)

    // A stream past the spill cap discards the spill instead of publishing a
    // truncated one; the in-memory tail is unaffected either way.
    const over = await sp.spawn(spec(
      [process.execPath, '-e', "process.stdout.write('z'.repeat(256))"],
      { stdout: { maxBytes: 64, spillMaxBytes: 32 } },
    ))
    await sp.waitForExit(over.procId)
    await awaitClose(over.procId)
    const overRead = sp.readOutput(over.procId, 'stdout', 0)
    assert.equal(overRead.lossy, true)
    assert.equal(Buffer.from(overRead.data, 'base64').toString('utf8'), 'z'.repeat(64))
  })

  it('retains closed output until the backend closes', async () => {
    const { procId } = await sp.spawn(spec([process.execPath, '-e', "process.stdout.write('kept')"]))
    await sp.waitForExit(procId)
    await awaitClose(procId)
    assert.equal(bytesOf(procId).toString('utf8'), 'kept')
    assert.equal(sp.outcome(procId)?.exitCode, 0)

    sp.close()
    assert.equal(await failureCode(() => sp.outcome(procId)), 'SP_NO_SUCH_PROCESS')
  })

  it('pushes every piped byte as frames a consumer reassembles exactly', async () => {
    const written = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a, 0xc3, 0xa9])
    const script = `process.stdout.write(Buffer.from([${[...written].join(',')}]))`
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', script],
      { stdout: 'pipe', stderr: 'inherit' },
    ))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const stdout = framesFor(procId, 'stdout')
    assert.ok(stdout.length > 0, 'no frames arrived')
    assert.deepEqual(pipedBytes(procId, 'stdout'), written)
    assert.equal(framesFor(procId, 'stderr').length, 0)
  })

  it('numbers pipe frames from zero, one step per frame', async () => {
    const script = [
      'let sent = 0',
      'const timer = setInterval(() => {',
      "  process.stdout.write('chunk\\n')",
      '  if (++sent === 5) clearInterval(timer)',
      '}, 40)',
    ].join('\n')
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', script],
      { stdout: 'pipe' },
    ))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const sequences = framesFor(procId, 'stdout').map(frame => frame.seq)
    assert.ok(sequences.length >= 2, `only ${sequences.length} frames for five writes`)
    assert.deepEqual(sequences, sequences.map((_value, index) => index))
    assert.equal(pipedBytes(procId, 'stdout').toString('utf8'), 'chunk\n'.repeat(5))
  })

  it('keeps both piped streams on their own sequence', async () => {
    const script = [
      "process.stdout.write('out-1\\n')",
      "process.stderr.write('err-1\\n')",
      "process.stdout.write('out-2\\n')",
      "process.stderr.write('err-2\\n')",
    ].join('\n')
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', script],
      { stdout: 'pipe', stderr: 'pipe' },
    ))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    assert.equal(pipedBytes(procId, 'stdout').toString('utf8'), 'out-1\nout-2\n')
    assert.equal(pipedBytes(procId, 'stderr').toString('utf8'), 'err-1\nerr-2\n')
    for (const stream of ['stdout', 'stderr'] as const) {
      const sequences = framesFor(procId, stream).map(frame => frame.seq)
      assert.deepEqual(sequences, sequences.map((_value, index) => index))
    }
  })

  it('refuses a window read of a piped stream but still serves a collected one', async () => {
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', "process.stdout.write('a'); process.stderr.write('b')"],
      { stdout: 'pipe', stderr: { maxBytes: 1 << 10 } },
    ))
    assert.equal(await failureCode(() => sp.readOutput(procId, 'stdout', 0)), 'SP_UNSUPPORTED_STDIO')

    await sp.waitForExit(procId)
    await awaitClose(procId)
    assert.equal(bytesOf(procId, 'stderr').toString('utf8'), 'b')
    assert.equal(pipedBytes(procId, 'stdout').toString('utf8'), 'a')
  })

  it('pushes no frame after the process exits', async () => {
    const { procId } = await sp.spawn(spec(
      [process.execPath, '-e', "process.stdout.write('last')"],
      { stdout: 'pipe' },
    ))
    await sp.waitForExit(procId)
    await awaitClose(procId)

    const delivered = framesFor(procId, 'stdout').length
    assert.ok(delivered > 0, 'the final flush never arrived')
    assert.equal(pipedBytes(procId, 'stdout').toString('utf8'), 'last')
    await sleep(150)
    assert.equal(framesFor(procId, 'stdout').length, delivered)
  })

  it('drops a process whose piped consumer stops draining', async () => {
    // A sender that never settles stands in for a socket nobody reads.
    const held: SpPipeFrame[] = []
    const blocked = new Promise<void>(() => {})
    const stalled = createSubprocessBackend(async (frame) => {
      held.push(frame)
      await blocked
    })
    try {
      const script = 'process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x78))'
      const { procId } = await stalled.spawn(spec([process.execPath, '-e', script], { stdout: 'pipe' }))

      const outcome = await until(
        () => stalled.outcome(procId) ?? undefined,
        'the stalled process to be dropped',
      )
      assert.equal(held.length, MAX_PIPE_BACKLOG_FRAMES)
      assert.deepEqual(
        held.map(frame => frame.seq),
        held.map((_frame, index) => index),
      )
      // The write never finished: the daemon dropped the process mid-stream
      // rather than retaining the rest, and the drop was a kill, not an exit.
      const delivered = held.reduce((total, frame) => total + Buffer.from(frame.data, 'base64').length, 0)
      assert.ok(delivered < 8 * 1024 * 1024, `the whole stream was delivered (${delivered} bytes)`)
      assert.notEqual(outcome.exitCode, 0)
    } finally {
      stalled.close()
    }
  })
})
