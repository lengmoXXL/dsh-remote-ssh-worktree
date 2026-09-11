/**
 * Terminal operations behind the daemon's `term.*` wire methods.
 *
 * A PTY is allocated with `node-pty` and detached from its own session, so the
 * daemon can address the whole terminal session by process group: termination
 * and foreground signalling both work on the group the terminal driver
 * published, not on the shell alone. Output is kept as raw bytes and addressed
 * by whole-stream byte offset, exactly like `sp.readOutput`.
 *
 * One backend owns the terminals one connection allocated; {@link
 * TerminalBackend.close} kills their sessions and releases their buffers when
 * that connection ends.
 *
 * @module dsh-remote-agent/terminal
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import * as nodePty from 'node-pty'
import type { IDisposable, IPty } from 'node-pty'
import type {
  WireOutcome,
  WireOutputRead,
  WireTerminalForeground,
  WireTerminalSignal,
  WireTerminalSpawnSpec,
} from '../../shared/protocol.ts'
import { StreamBuffer, SubprocessFailure, scrubbedEnvironment, usableDirectory } from './subprocess.ts'

/**
 * Bytes of terminal output the daemon retains for `term.read`.
 *
 * A terminal's scrollback is unbounded, so the window is capped; a reader whose
 * offset has slid out of it is told through `lossy` rather than served a
 * silently shortened stream.
 */
const TERMINAL_WINDOW_BYTES = 1 << 20

/** Interval between session liveness checks while a terminal is terminated. */
const SESSION_POLL_MS = 25

/** Terminal name the daemon publishes as `TERM`. */
const TERMINAL_NAME = 'xterm-256color'

/** The terminal methods the daemon serves, one per `term.*` wire method. */
export interface TerminalBackend {
  /**
   * Allocate a PTY and start a program on it.
   * @param spec - the fully specified allocation.
   * @returns the identifier later calls address, and the session leader's pid.
   * @throws SubprocessFailure `SP_TERMINAL_FAILED` when the directory is
   *   unusable or the PTY cannot be allocated.
   */
  spawn(spec: WireTerminalSpawnSpec): Promise<{ readonly termId: string; readonly pid: number }>
  /**
   * Read retained terminal output from a whole-stream byte offset.
   * @param termId - a terminal this connection allocated.
   * @param fromByte - whole-stream offset to read from.
   * @returns the base64 bytes from there, the resume offset, and whether the
   *   offset had already slid out of the retained window.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL`.
   */
  read(termId: string, fromByte: number): WireOutputRead
  /**
   * Deliver text to the terminal input.
   * @param termId - a terminal this connection allocated.
   * @param data - the exact bytes to write, encoded as UTF-8; no newline is added.
   * @returns an empty result object.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL` or `SP_TERMINAL_FAILED`
   *   when the session's top-level process has already exited.
   */
  write(termId: string, data: string): Record<string, never>
  /**
   * Report the current foreground process group.
   * @param termId - a terminal this connection allocated.
   * @returns the group and whether the daemon can prove it waits on input, or
   *   `null` when no foreground group can be resolved.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL`.
   */
  inspectForeground(termId: string): Promise<WireTerminalForeground | null>
  /**
   * Deliver a signal to the current foreground process group.
   * @param termId - a terminal this connection allocated.
   * @param signal - the signal to deliver.
   * @returns the process group that received it.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL`, or `SP_TERMINAL_FAILED`
   *   when no foreground group resolves or the platform cannot deliver it.
   */
  signalForeground(termId: string, signal: WireTerminalSignal): Promise<{ readonly processGroupId: number }>
  /**
   * Terminate the whole terminal session.
   *
   * Signals `SIGTERM` to the session, waits up to the allocation's grace, then
   * `SIGKILL`, and answers only once no session member is still observable.
   * A repeat call joins the same teardown instead of starting another.
   * @param termId - a terminal this connection allocated.
   * @returns an empty result object.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL`, or `SP_TERMINAL_FAILED`
   *   when a session member survives the ladder.
   */
  terminate(termId: string): Promise<Record<string, never>>
  /**
   * Read the exit facts of the session's top-level process.
   * @param termId - a terminal this connection allocated.
   * @returns the exit facts, or `null` while it still runs.
   * @throws SubprocessFailure `SP_NO_SUCH_TERMINAL`.
   */
  outcome(termId: string): WireOutcome | null
  /**
   * Kill every terminal session this connection allocated and release its buffers.
   * @returns nothing; safe to call more than once.
   */
  close(): void
}

/**
 * Build the terminal backend for one connection.
 * @returns the backend owning the terminals this connection allocates.
 */
export function createTerminalBackend(): TerminalBackend {
  const terminals = new Map<string, ManagedTerminal>()

  /** The terminal behind an id, or the typed failure. */
  const require = (termId: string): ManagedTerminal => {
    const terminal = terminals.get(termId)
    if (terminal === undefined) {
      throw new SubprocessFailure('SP_NO_SUCH_TERMINAL', `no such terminal "${termId}"`)
    }
    return terminal
  }

  return {
    async spawn(spec) {
      const program = spec.argv[0]
      if (program === undefined) {
        throw new SubprocessFailure('SP_TERMINAL_FAILED', 'cannot allocate a terminal: argv does not name a program')
      }
      const cwd = await usableDirectory(spec.cwd, 'SP_TERMINAL_FAILED')
      let terminal: IPty
      try {
        terminal = nodePty.spawn(program, spec.argv.slice(1), {
          name: TERMINAL_NAME,
          cols: spec.cols,
          rows: spec.rows,
          cwd,
          env: { ...scrubbedEnvironment(), ...spec.env },
          // Raw bytes, so a character split across two reads is never decoded
          // into replacement text before it reaches the caller.
          encoding: null,
        })
      } catch (error: unknown) {
        throw new SubprocessFailure(
          'SP_TERMINAL_FAILED',
          `cannot allocate a terminal for "${program}": ${describe(error)}`,
          { cause: error },
        )
      }
      const termId = randomUUID()
      terminals.set(termId, new ManagedTerminal(terminal, spec.graceMs))
      return { termId, pid: terminal.pid }
    },

    read(termId, fromByte) {
      return require(termId).read(fromByte)
    },

    write(termId, data) {
      require(termId).write(data)
      return {}
    },

    async inspectForeground(termId) {
      return await require(termId).inspectForeground()
    },

    async signalForeground(termId, signal) {
      return { processGroupId: await require(termId).signalForeground(signal) }
    },

    async terminate(termId) {
      await require(termId).terminate()
      return {}
    },

    outcome(termId) {
      return require(termId).outcome()
    },

    close() {
      for (const terminal of terminals.values()) terminal.dispose()
      terminals.clear()
    },
  }
}

/** One allocated terminal: its retained output, exit facts, and teardown. */
class ManagedTerminal {
  private readonly terminal: IPty
  private readonly pid: number
  private readonly graceMs: number
  private readonly output = new StreamBuffer({ maxBytes: TERMINAL_WINDOW_BYTES }, undefined)
  private readonly dataSubscription: IDisposable
  private readonly exitSubscription: IDisposable
  private exitFacts: WireOutcome | null = null
  private cleanup: Promise<void> | undefined

  /**
   * @param terminal - the PTY `node-pty` just allocated.
   * @param graceMs - how long `SIGTERM` may take before `SIGKILL`.
   */
  constructor(terminal: IPty, graceMs: number) {
    this.terminal = terminal
    this.pid = terminal.pid
    this.graceMs = graceMs
    this.dataSubscription = terminal.onData((data: string) => {
      this.output.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    })
    this.exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      this.exitFacts = {
        exitCode: signal === undefined || signal === 0 ? exitCode : null,
        signal: signalName(signal),
      }
    })
  }

  /** The retained output from a whole-stream offset. */
  read(fromByte: number): WireOutputRead {
    return this.output.read(fromByte)
  }

  /** Deliver text to the terminal input. */
  write(data: string): void {
    if (this.exitFacts !== null) {
      throw new SubprocessFailure('SP_TERMINAL_FAILED', `terminal ${this.pid} has exited`)
    }
    try {
      this.terminal.write(data)
    } catch (error: unknown) {
      throw new SubprocessFailure('SP_TERMINAL_FAILED', `cannot write to terminal ${this.pid}: ${describe(error)}`, { cause: error })
    }
  }

  /** The foreground process group, or `null` when none resolves. */
  async inspectForeground(): Promise<WireTerminalForeground | null> {
    const processGroupId = await foregroundGroupId(this.pid)
    if (processGroupId === undefined) return null
    return { processGroupId, inputWaiting: await groupWaitsOnInput(processGroupId, this.pid) }
  }

  /** Deliver a signal to the foreground process group. */
  async signalForeground(signal: WireTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === null) {
      throw new SubprocessFailure(
        'SP_TERMINAL_FAILED',
        `cannot resolve the foreground process group of terminal ${this.pid}`,
      )
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new SubprocessFailure(
        'SP_TERMINAL_FAILED',
        'refusing to SIGKILL the terminal shell; terminate the terminal session instead',
      )
    }
    if (process.platform === 'win32') {
      this.signalWindows(signal)
      return foreground.processGroupId
    }
    try {
      process.kill(-foreground.processGroupId, signal)
    } catch (error: unknown) {
      throw new SubprocessFailure(
        'SP_TERMINAL_FAILED',
        `cannot signal process group ${foreground.processGroupId}: ${describe(error)}`,
        { cause: error },
      )
    }
    return foreground.processGroupId
  }

  /** The exit facts of the session's top-level process, or `null` while it runs. */
  outcome(): WireOutcome | null {
    return this.exitFacts
  }

  /** Run the TERM-to-KILL ladder once; later calls join the same teardown. */
  terminate(): Promise<void> {
    this.cleanup ??= this.escalate()
    void this.cleanup.catch(() => {
      // A failed ladder may be retried by a later call.
      this.cleanup = undefined
    })
    return this.cleanup
  }

  /** Kill the session and release the buffers; safe to call more than once. */
  dispose(): void {
    this.signalSession('SIGKILL')
    this.dataSubscription.dispose()
    this.exitSubscription.dispose()
    this.output.dispose()
  }

  /** Signal the session, falling back to the top-level process. */
  private signalSession(signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      try {
        this.terminal.kill(signal)
      } catch {
        // The session already ended; teardown stays idempotent.
      }
      return
    }
    try {
      process.kill(-this.pid, signal)
    } catch {
      try {
        this.terminal.kill(signal)
      } catch {
        // The group and the top-level process are both gone.
      }
    }
  }

  /** POSIX signals have no Windows process-group equivalent. */
  private signalWindows(signal: WireTerminalSignal): void {
    if (signal === 'SIGINT') {
      // A `\x03` write is the Ctrl-C delivery path conhost turns into a
      // console-wide event; node-pty's own signal path throws on Windows.
      try {
        this.terminal.write('\x03')
      } catch (error: unknown) {
        throw new SubprocessFailure('SP_TERMINAL_FAILED', `cannot interrupt terminal ${this.pid}: ${describe(error)}`, { cause: error })
      }
      return
    }
    if (signal === 'SIGTSTP' || signal === 'SIGHUP') {
      throw new SubprocessFailure(
        'SP_TERMINAL_FAILED',
        `${signal} is not available on Windows; only SIGINT, SIGTERM, and SIGKILL are`,
      )
    }
    try {
      this.terminal.kill(signal)
    } catch (error: unknown) {
      throw new SubprocessFailure('SP_TERMINAL_FAILED', `cannot signal terminal ${this.pid}: ${describe(error)}`, { cause: error })
    }
  }

  /** SIGTERM the session, then SIGKILL it, then confirm it is gone. */
  private async escalate(): Promise<void> {
    this.signalSession('SIGTERM')
    if (await this.sessionGoneWithin(this.graceMs)) return
    this.signalSession('SIGKILL')
    if (await this.sessionGoneWithin(this.graceMs)) return
    throw new SubprocessFailure(
      'SP_TERMINAL_FAILED',
      `terminal ${this.pid} still had session members after SIGKILL`,
    )
  }

  /** Wait for the session to disappear, up to `ms`. */
  private async sessionGoneWithin(ms: number): Promise<boolean> {
    const until = Date.now() + ms
    for (;;) {
      if (!this.sessionAlive()) return true
      if (Date.now() >= until) return false
      await sleep(SESSION_POLL_MS)
    }
  }

  /** Whether any session member is still observable. */
  private sessionAlive(): boolean {
    if (process.platform === 'win32') return this.exitFacts === null
    try {
      process.kill(-this.pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM means the group exists but is not ours to signal; anything but
      // ESRCH is treated as alive rather than reporting a false exit.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}

/**
 * The foreground process-group id of one terminal, or `undefined` when the
 * platform cannot report one.
 *
 * Linux publishes it as `tpgid` in `/proc/<pid>/stat`; macOS exposes the same
 * field through `ps`. A `tpgid` of 0 or -1 means the process has no foreground
 * group on its controlling terminal.
 * @param shellPid - the terminal session leader.
 * @returns the foreground group id, or `undefined`.
 */
async function foregroundGroupId(shellPid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    const fields = await procStat(shellPid)
    return fields !== undefined && fields.tpgid > 0 ? fields.tpgid : undefined
  }
  if (process.platform === 'darwin') {
    try {
      const output = await runPs(['-o', 'tpgid=', '-p', String(shellPid)])
      const value = Number(output.trim())
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    } catch {
      // A process that exited between inspection steps has no foreground group.
      return undefined
    }
  }
  return undefined
}

/**
 * Whether the daemon can prove the foreground group waits on terminal input.
 *
 * Only Linux exposes the evidence this build can read: a group member sleeping
 * in the tty line discipline's read on this terminal's controlling device. Any
 * other platform, and every unreadable or ambiguous case, answers `false`
 * rather than guessing.
 * @param processGroupId - the foreground process group.
 * @param shellPid - the terminal session leader.
 * @returns true only when a member is provably blocked reading this terminal.
 */
async function groupWaitsOnInput(processGroupId: number, shellPid: number): Promise<boolean> {
  if (process.platform !== 'linux') return false
  const leader = await procStat(shellPid)
  if (leader === undefined || leader.ttyDevice <= 0) return false
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    // A /proc that cannot be listed proves nothing.
    return false
  }
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const member = await procStat(pid)
    if (member === undefined) continue
    if (member.processGroup !== processGroupId || member.ttyDevice !== leader.ttyDevice) continue
    if (await waitsOnTty(pid)) return true
  }
  return false
}

/** The `/proc/<pid>/stat` fields this module needs, or `undefined` when unreadable. */
interface ProcStat {
  /** Process-group id (field 5). */
  readonly processGroup: number
  /** Controlling terminal device (field 7). */
  readonly ttyDevice: number
  /** Foreground process-group id of that terminal (field 8). */
  readonly tpgid: number
}

/**
 * Read one process's `/proc/<pid>/stat` fields.
 *
 * The command name between the first parentheses can contain spaces and
 * parentheses, so the numeric fields are read from after the last `)`.
 * @param pid - the process to read.
 * @returns the fields, or `undefined` when the file cannot be read or parsed.
 */
async function procStat(pid: number): Promise<ProcStat | undefined> {
  let raw: string
  try {
    raw = await readFile(`/proc/${String(pid)}/stat`, 'utf8')
  } catch {
    // The process exited, or /proc is not mounted.
    return undefined
  }
  const close = raw.lastIndexOf(')')
  if (close === -1) return undefined
  const fields = raw.slice(close + 2).split(' ')
  // state, ppid, pgrp, session, tty_nr, tpgid
  const processGroup = Number(fields[2])
  const ttyDevice = Number(fields[4])
  const tpgid = Number(fields[5])
  if (![processGroup, ttyDevice, tpgid].every(Number.isSafeInteger)) return undefined
  return { processGroup, ttyDevice, tpgid }
}

/** Whether a process is sleeping in the tty line discipline's read. */
async function waitsOnTty(pid: number): Promise<boolean> {
  try {
    const channel = await readFile(`/proc/${String(pid)}/wchan`, 'utf8')
    return channel.includes('n_tty_read')
  } catch {
    // An unreadable wait channel is not evidence of a wait.
    return false
  }
}

/** Run `/bin/ps` and return stdout. */
async function runPs(args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', [...args], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      if (error === null) resolve(stdout)
      else reject(error)
    })
  })
}

/** The name of a terminating signal number, or `null`. */
function signalName(number: number | undefined): string | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name
  }
  return null
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
