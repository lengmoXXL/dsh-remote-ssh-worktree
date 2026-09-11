/**
 * Behavior tests for the daemon's terminal operations.
 *
 * The fixtures are real PTY sessions, so the foreground-group inspection, the
 * session-wide termination ladder, and the byte-exact terminal stream are
 * observed against the operating system. A host that cannot allocate a PTY —
 * a sandbox without `/dev/ptmx`, for instance — skips those cases explicitly
 * while the validation and unknown-id cases still run.
 *
 * @module dsh-remote-agent/tests/terminal
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, before, beforeEach, describe, it } from 'node:test'
import type { WireTerminalSpawnSpec } from '../../shared/protocol.ts'
import { SubprocessFailure } from '../src/subprocess.ts'
import type { TerminalBackend } from '../src/terminal.ts'
import { createTerminalBackend } from '../src/terminal.ts'

/** Poll interval while waiting for a terminal to reach a state. */
const POLL_MS = 20

/** Give up on a fixture after this long. */
const DEADLINE_MS = 10_000

/** A binary that exists on every POSIX host this daemon supports. */
const SHELL = '/bin/sh'

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Poll `probe` until it answers, or fail once the deadline passes. */
async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  deadlineMs = DEADLINE_MS,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started > deadlineMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_MS)
  }
}

/** Whether any member of a session is still observable. */
function sessionAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
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

/**
 * Whether this host can allocate a PTY, and why not when it cannot. A real
 * allocation is the only honest probe: `node-pty` loads everywhere, but the
 * kernel refuses `/dev/ptmx` in a restricted sandbox.
 */
async function probePty(): Promise<string | undefined> {
  const probe = createTerminalBackend()
  try {
    const { termId } = await probe.spawn({
      argv: [SHELL, '-c', 'true'],
      cwd: tmpdir(),
      rows: 24,
      cols: 80,
      graceMs: 500,
    })
    await probe.terminate(termId)
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    probe.close()
  }
}

describe('terminal backend', () => {
  let dir: string
  let term: TerminalBackend
  let ptyBlocked: string | undefined

  before(async () => {
    ptyBlocked = await probePty()
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-term-'))
    term = createTerminalBackend()
  })

  afterEach(async () => {
    term.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** A terminal allocation over the fixture directory, overridden per test. */
  function spec(overrides: Partial<WireTerminalSpawnSpec> = {}): WireTerminalSpawnSpec {
    return {
      argv: [SHELL],
      cwd: dir,
      rows: 24,
      cols: 80,
      graceMs: 500,
      ...overrides,
    }
  }

  /** Everything the terminal has emitted so far, decoded for assertions. */
  function output(termId: string): string {
    return Buffer.from(term.read(termId, 0).data, 'base64').toString('utf8')
  }

  /** Report the PTY skip for a case that needs a real terminal. */
  function skipWithoutPty(t: { skip: (reason: string) => void }): boolean {
    if (ptyBlocked === undefined) return false
    t.skip(`node-pty cannot allocate a PTY on this host: ${ptyBlocked}`)
    return true
  }

  it('reports an unknown terminal everywhere a terminal is addressed', async () => {
    assert.equal(await failureCode(() => term.read('nope', 0)), 'SP_NO_SUCH_TERMINAL')
    assert.equal(await failureCode(() => term.write('nope', 'x')), 'SP_NO_SUCH_TERMINAL')
    assert.equal(await failureCode(() => term.inspectForeground('nope')), 'SP_NO_SUCH_TERMINAL')
    assert.equal(await failureCode(() => term.signalForeground('nope', 'SIGINT')), 'SP_NO_SUCH_TERMINAL')
    assert.equal(await failureCode(() => term.terminate('nope')), 'SP_NO_SUCH_TERMINAL')
    assert.equal(await failureCode(() => term.outcome('nope')), 'SP_NO_SUCH_TERMINAL')
  })

  it('refuses an allocation it cannot start', async () => {
    assert.equal(await failureCode(() => term.spawn(spec({ argv: [] }))), 'SP_TERMINAL_FAILED')
    assert.equal(await failureCode(() => term.spawn(spec({ cwd: 'relative' }))), 'SP_TERMINAL_FAILED')
    assert.equal(
      await failureCode(() => term.spawn(spec({ cwd: join(dir, 'missing') }))),
      'SP_TERMINAL_FAILED',
    )
  })

  it('reads command output byte-exactly for two independent readers', async t => {
    if (skipWithoutPty(t)) return
    const { termId } = await term.spawn(spec({ argv: [SHELL, '-c', 'printf hello'] }))

    const first = await until(() => {
      const read = term.read(termId, 0)
      return read.nextOffset > 0 ? read : undefined
    }, 'terminal output')
    assert.equal(Buffer.from(first.data, 'base64').toString('utf8'), 'hello')
    assert.equal(first.lossy, false)

    const second = term.read(termId, 0)
    assert.equal(second.data, first.data)
    assert.equal(second.nextOffset, first.nextOffset)
    assert.equal(second.lossy, false)
  })

  it('reports lossy once the retained window has been trimmed', async t => {
    if (skipWithoutPty(t)) return
    // One byte past the retained window is what makes it trim; the extra
    // 64 KiB is what forces the whole window to have been replaced.
    const total = (1 << 20) + (1 << 16)
    const { termId } = await term.spawn(spec({
      argv: [SHELL, '-c', `head -c ${String(total)} /dev/zero | tr '\\0' y`],
    }))

    // Wait for the producer to exit, not for a byte count. The child exiting is
    // the definitive end of output; sampling the offset instead means reading
    // and concatenating the whole window on every poll, which competes with the
    // PTY drain in this same process. A daemon that lost output still fails the
    // assertions below, with the count it actually reached.
    await until(() => term.outcome(termId) ?? undefined, 'the command to exit')

    // The exit event and the final data event are separate, and on some
    // PTY builds the tail arrives after the exit. Wait for the stream to stop
    // advancing before reading the claim; a daemon that lost bytes still fails
    // the assertions below, and the wait above already named the real state.
    let quiescent = term.read(termId, 0).nextOffset
    for (;;) {
      await sleep(POLL_MS)
      const now = term.read(termId, 0).nextOffset
      if (now === quiescent) break
      quiescent = now
    }

    const read = term.read(termId, 0)
    assert.equal(read.lossy, true)
    assert.equal(read.nextOffset, total)
    const tail = Buffer.from(read.data, 'base64')
    assert.equal(tail.length, 1 << 20)
    assert.equal(tail.toString('utf8'), 'y'.repeat(1 << 20))
  })

  it('delivers writes to the terminal input', async t => {
    if (skipWithoutPty(t)) return
    const { termId } = await term.spawn(spec({ argv: ['/bin/cat'] }))

    term.write(termId, 'hello from the terminal\n')
    const text = await until(() => {
      const seen = output(termId)
      return seen.includes('hello from the terminal') ? seen : undefined
    }, 'the terminal to echo the write')
    assert.ok(text.includes('hello from the terminal'))
  })

  it('reports the foreground process group of a running command', async t => {
    if (skipWithoutPty(t)) return
    const { termId } = await term.spawn(spec({ argv: [SHELL] }))
    term.write(termId, 'sleep 30\n')

    // The write only asks the shell to run the command; the group exists once
    // the shell has forked it, so a single sample races the shell.
    const foreground = await until(
      async () => (await term.inspectForeground(termId)) ?? undefined,
      'a foreground process group',
    )

    assert.ok(foreground.processGroupId > 0, `${String(foreground.processGroupId)} is not a group id`)
    assert.equal(typeof foreground.inputWaiting, 'boolean')
    if (process.platform !== 'linux') {
      // Only Linux exposes evidence this build can read; everywhere else the
      // daemon answers false rather than guessing a wait.
      assert.equal(foreground.inputWaiting, false)
    }
  })

  it('signals the foreground group and the command observes the signal', async t => {
    if (skipWithoutPty(t)) return
    const { termId } = await term.spawn(spec({
      argv: [SHELL, '-c', 'trap "printf CAUGHT" TERM; printf READY; sleep 30'],
    }))

    // READY proves the trap is installed, so the signal cannot race the setup.
    await until(() => (output(termId).includes('READY') ? true : undefined), 'the trap to be installed')
    const foreground = await until(
      async () => (await term.inspectForeground(termId)) ?? undefined,
      'a foreground process group',
    )

    const { processGroupId } = await term.signalForeground(termId, 'SIGTERM')
    assert.equal(processGroupId, foreground.processGroupId)
    await until(
      () => (output(termId).includes('CAUGHT') ? true : undefined),
      'the command to observe the signal',
    )
  })

  it('terminates a session whose shell ignores SIGTERM', async t => {
    if (skipWithoutPty(t)) return
    const { termId, pid } = await term.spawn(spec({
      argv: [SHELL, '-c', "trap '' TERM; printf READY; sleep 60"],
      graceMs: 300,
    }))
    await until(() => (output(termId).includes('READY') ? true : undefined), 'the trap to be installed')

    const startedAt = Date.now()
    await term.terminate(termId)
    assert.ok(Date.now() - startedAt >= 300, 'the ladder killed before its grace elapsed')
    await until(() => (sessionAlive(pid) ? undefined : true), 'the session to disappear')
    assert.equal(sessionAlive(pid), false)

    // A repeat call joins the finished teardown instead of starting another.
    await term.terminate(termId)
    assert.equal(sessionAlive(pid), false)
  })

  it('reports outcome as null while running and settled after exit', async t => {
    if (skipWithoutPty(t)) return
    const { termId } = await term.spawn(spec({ argv: [SHELL, '-c', 'sleep 1; exit 3'] }))
    assert.equal(term.outcome(termId), null)
    const outcome = await until(() => term.outcome(termId) ?? undefined, 'the terminal to exit')
    assert.deepEqual(outcome, { exitCode: 3, signal: null })
  })
})
