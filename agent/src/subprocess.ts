/**
 * Subprocess operations behind the daemon's `sp.*` wire methods.
 *
 * Every child is started as an argv array through `node:child_process.spawn`,
 * never through a shell, and (on POSIX) detached so it leads its own process
 * group: termination and {@link SubprocessBackend.waitForExit} address the
 * whole managed range, not just the top-level child. Collected output is kept
 * as raw bytes addressed by whole-stream byte offset, so two readers asking
 * from the same offset see the same bytes and nothing is decoded or normalized
 * on the way through.
 *
 * One backend owns the processes one connection started; {@link
 * SubprocessBackend.close} kills their ranges and releases their buffers when
 * that connection ends.
 *
 * @module dsh-remote-agent/subprocess
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Writable } from 'node:stream'
import { asProcId } from '../../shared/protocol.ts'
import type { ProcId, WireOutcome, WireOutputRead, WireSpawnSpec } from '../../shared/protocol.ts'
import type { PipeFrameSender } from './execution.ts'
import { StreamBuffer, SubprocessFailure, describe, scrubbedEnvironment, usableDirectory } from './execution.ts'

/** Interval between managed-range liveness checks after the child has exited. */
const GROUP_POLL_MS = 25

/**
 * Frames one piped stream may have in flight before the daemon stops feeding
 * its consumer.
 *
 * A frame is retained until the socket write carrying it completes, so a
 * consumer that never drains would otherwise grow the daemon's memory without
 * bound. At this backlog the daemon drops the process — running its termination
 * ladder — instead of buffering: the consumer already sees the gap from the
 * last `seq` it received, and a terminated process is recoverable, unlike an
 * exhausted daemon.
 */
export const MAX_PIPE_BACKLOG_FRAMES = 64

/** Largest delay Node's timers accept, and therefore the largest usable grace. */
export const MAX_GRACE_MS = 2_147_483_647

/** Directory holding this daemon's spill files when a spawn requests one. */
const SPILL_ROOT = join(tmpdir(), 'dsh-remote-agent-spill')

/** The subprocess methods the daemon serves, one per `sp.*` wire method. */
export interface SubprocessBackend {
  /**
   * Resolve a program name to an absolute executable path.
   *
   * An absolute path is verified and canonicalized. A bare name is searched on
   * `env.PATH` when given, else the daemon's own `PATH`; a relative path that
   * contains a separator is refused rather than resolved against any working
   * directory.
   * @param command - the program name or path.
   * @param env - the caller's environment overlay, consulted only for `PATH`.
   * @returns the canonical absolute path of the executable.
   * @throws SubprocessFailure `SP_NOT_FOUND` when nothing matches and
   *   `SP_NOT_EXECUTABLE` for a path that is not a regular executable file.
   */
  resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<{ readonly path: string }>
  /**
   * Start a child process and keep its collected output and exit facts.
   * @param spec - the fully specified spawn request.
   * @returns the identifier every later `sp.*` call addresses.
   * @throws SubprocessFailure `SP_SPAWN_FAILED` when the directory is unusable
   *   or the program cannot be started.
   */
  spawn(spec: WireSpawnSpec): Promise<{ readonly procId: ProcId }>
  /**
   * Read one collected stream from a whole-stream byte offset.
   *
   * The read consumes nothing: it is a view of the retained window, so two
   * callers asking from the same offset see the same bytes.
   * @param procId - a process this connection started.
   * @param stream - which collected stream to read.
   * @param fromByte - whole-stream offset to read from.
   * @returns the base64 bytes from that offset, the offset to resume from, and
   *   whether the requested offset had already slid out of the window (in
   *   which case the whole retained tail is returned).
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS` or `SP_UNSUPPORTED_STDIO`
   *   when the stream was not collected.
   */
  readOutput(procId: ProcId, stream: 'stdout' | 'stderr', fromByte: number): WireOutputRead
  /**
   * Write bytes to a child started with piped stdin.
   * @param procId - a process this connection started.
   * @param data - the text to write, encoded as UTF-8.
   * @returns an empty result object.
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS` or `SP_UNSUPPORTED_STDIO`.
   */
  writeStdin(procId: ProcId, data: string): Record<string, never>
  /**
   * Close a child's piped stdin.
   * @param procId - a process this connection started.
   * @returns an empty result object.
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS` or `SP_UNSUPPORTED_STDIO`.
   */
  closeStdin(procId: ProcId): Record<string, never>
  /**
   * Signal the managed range and escalate to `SIGKILL` after the grace period.
   *
   * Idempotent: a second call while the ladder runs, and a call after the
   * range closed, are no-ops.
   * @param procId - a process this connection started.
   * @returns an empty result object.
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS`.
   */
  terminate(procId: ProcId): Record<string, never>
  /**
   * Wait until the whole managed range is gone, not merely the direct child.
   * @param procId - a process this connection started.
   * @returns `{ empty: true }` once no member of the range is left.
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS`.
   */
  waitForExit(procId: ProcId): Promise<{ readonly empty: boolean }>
  /**
   * Read the exit facts of a closed child.
   * @param procId - a process this connection started.
   * @returns the exit code and terminating signal, or `null` while the child
   *   has not closed yet.
   * @throws SubprocessFailure `SP_NO_SUCH_PROCESS`.
   */
  outcome(procId: ProcId): WireOutcome | null
  /**
   * Kill every managed range and release every retained buffer.
   * @returns nothing; safe to call more than once.
   */
  close(): void
}

/**
 * Build the subprocess backend for one connection.
 * @param send - delivers one pipe frame to the connection that owns the process.
 * @returns the backend owning the processes this connection starts.
 */
export function createSubprocessBackend(send: PipeFrameSender): SubprocessBackend {
  const processes = new Map<string, ManagedProcess>()

  /** The managed process behind an id, or the typed failure. */
  const require = (procId: ProcId): ManagedProcess => {
    const process_ = processes.get(procId)
    if (process_ === undefined) {
      throw new SubprocessFailure('SP_NO_SUCH_PROCESS', `no such process "${procId}"`)
    }
    return process_
  }

  return {
    async resolveExecutable(command, env) {
      if (isAbsolute(command)) return { path: await canonicalExecutable(command) }
      if (/[\\/]/.test(command)) {
        throw new SubprocessFailure(
          'SP_NOT_EXECUTABLE',
          `cannot resolve "${command}": a relative path is not an executable name`,
        )
      }
      const searchPath = env?.['PATH'] ?? process.env['PATH'] ?? ''
      for (const directory of searchPath.split(delimiter)) {
        // An empty entry means "the current directory" to some shells; the
        // daemon never resolves a program relative to a working directory.
        if (directory.length === 0) continue
        try {
          return { path: await canonicalExecutable(join(directory, command)) }
        } catch {
          // Not this directory; the PATH walk continues, as a shell's would.
        }
      }
      throw new SubprocessFailure('SP_NOT_FOUND', `cannot resolve "${command}": not found on PATH`)
    },

    async spawn(spec) {
      const program = spec.argv[0]
      if (program === undefined) {
        throw new SubprocessFailure('SP_SPAWN_FAILED', 'cannot spawn: argv does not name a program')
      }
      const cwd = await usableDirectory(spec.cwd, 'SP_SPAWN_FAILED')
      const procId = asProcId(randomUUID())
      const spillDirectory = needsSpill(spec.stdout, spec.stderr) ? join(SPILL_ROOT, procId) : undefined
      if (spillDirectory !== undefined) await mkdir(spillDirectory, { recursive: true })
      const child = spawn(program, spec.argv.slice(1), {
        cwd,
        env: { ...scrubbedEnvironment(), ...spec.env },
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: [stdinDisposition(spec.stdin), outputDisposition(spec.stdout), outputDisposition(spec.stderr)],
      })
      // The lifecycle listeners are attached before the spawn result is
      // awaited, so an instantly exiting child cannot outrun them.
      const managed = new ManagedProcess(procId, child, spec, spillDirectory, send)
      try {
        await awaitSpawn(child, program)
      } catch (error: unknown) {
        managed.dispose()
        throw error
      }
      processes.set(procId, managed)
      if (typeof spec.stdin === 'object') {
        managed.writeStdin(spec.stdin.data)
        managed.closeStdin()
      }
      return { procId }
    },

    readOutput(procId, stream, fromByte) {
      const managed = require(procId)
      const buffer = stream === 'stdout' ? managed.stdout : managed.stderr
      if (buffer === undefined) {
        throw new SubprocessFailure(
          'SP_UNSUPPORTED_STDIO',
          `process "${procId}" did not collect ${stream}`,
        )
      }
      return buffer.read(fromByte)
    },

    writeStdin(procId, data) {
      require(procId).writeStdin(data)
      return {}
    },

    closeStdin(procId) {
      require(procId).closeStdin()
      return {}
    },

    terminate(procId) {
      require(procId).terminate()
      return {}
    },

    async waitForExit(procId) {
      await require(procId).waitForExit()
      return { empty: true }
    },

    outcome(procId) {
      return require(procId).outcome()
    },

    close() {
      for (const managed of processes.values()) managed.dispose()
      processes.clear()
    },
  }
}

/** One managed child: its collected streams, exit facts, and termination ladder. */
class ManagedProcess {
  readonly stdout: StreamBuffer | undefined
  readonly stderr: StreamBuffer | undefined

  private readonly procId: ProcId
  private readonly child: ChildProcess
  private readonly pid: number | undefined
  private readonly stdin: Writable | undefined
  private readonly graceMs: number
  private readonly spillDirectory: string | undefined
  private readonly send: PipeFrameSender
  private readonly exited: Promise<void>
  private readonly sequence: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 }
  private readonly backlog: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 }
  private exitFacts: WireOutcome | null = null
  private settled: WireOutcome | null = null
  private settleTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private terminating = false
  private pipeAbandoned = false
  private disposed = false

  /**
   * @param procId - the identifier frames and later calls carry.
   * @param child - the process `spawn` just returned.
   * @param spec - the request that started it.
   * @param spillDirectory - where this process's spill files live, or `undefined`.
   * @param send - delivers one pipe frame to this connection.
   */
  constructor(
    procId: ProcId,
    child: ChildProcess,
    spec: WireSpawnSpec,
    spillDirectory: string | undefined,
    send: PipeFrameSender,
  ) {
    this.procId = procId
    this.send = send
    this.child = child
    this.pid = child.pid
    this.graceMs = spec.graceMs
    this.spillDirectory = spillDirectory
    this.stdin = child.stdin ?? undefined
    this.stdout = collectBuffer(spec.stdout, spillDirectory, 'stdout')
    this.stderr = collectBuffer(spec.stderr, spillDirectory, 'stderr')
    child.stdout?.on('data', (chunk: Buffer) => { this.capture('stdout', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { this.capture('stderr', chunk) })
    // A write to a child that already closed its stdin rejects asynchronously;
    // the pipe is best-effort, so the failure must not reach the daemon.
    this.stdin?.on('error', () => {})
    // After a successful spawn a later child error means the process is
    // unusable; its exit path reports that to the caller.
    child.on('error', () => {})
    this.exited = new Promise<void>(resolve => {
      child.once('exit', (code, signal) => {
        this.exitFacts = { exitCode: code, signal }
        // A survivor holding a collected pipe open would otherwise keep the
        // child's `close` event pending forever; the caller's grace bounds it.
        this.settleTimer = setTimeout(() => { this.settle() }, this.graceMs)
        this.settleTimer.unref()
        resolve()
      })
      child.once('close', () => {
        this.settle()
        resolve()
      })
    })
  }

  /** Write to the child's piped stdin. */
  writeStdin(data: string): void {
    if (this.stdin === undefined) {
      throw new SubprocessFailure('SP_UNSUPPORTED_STDIO', 'this process was not started with piped stdin')
    }
    this.stdin.write(data)
  }

  /** Close the child's piped stdin; a second close is harmless. */
  closeStdin(): void {
    if (this.stdin === undefined) {
      throw new SubprocessFailure('SP_UNSUPPORTED_STDIO', 'this process was not started with piped stdin')
    }
    this.stdin.end()
  }

  /** Start the terminate ladder once. */
  terminate(): void {
    if (this.terminating || this.settled !== null) return
    this.terminating = true
    this.signal('SIGTERM')
    this.killTimer = setTimeout(() => { this.signal('SIGKILL') }, this.graceMs)
    this.killTimer.unref()
  }

  /** Resolve once no member of the managed range is left. */
  async waitForExit(): Promise<void> {
    await this.exited
    while (this.groupAlive()) await sleep(GROUP_POLL_MS)
    this.clearTimer('killTimer')
  }

  /** The exit facts, or `null` while the child has not closed. */
  outcome(): WireOutcome | null {
    return this.settled
  }

  /** Kill the range and release the buffers; safe to call more than once. */
  dispose(): void {
    this.disposed = true
    this.clearTimer('settleTimer')
    this.clearTimer('killTimer')
    if (this.settled === null && this.groupAlive()) this.signal('SIGKILL')
    this.stdin?.destroy()
    this.stdout?.dispose()
    this.stderr?.dispose()
    if (this.spillDirectory !== undefined) {
      void rm(this.spillDirectory, { recursive: true, force: true }).catch(() => {
        // A spill file left in the temp directory is inert and bounded by its
        // own cap; the connection is already gone.
      })
    }
  }

  /**
   * Retain one chunk for a collected window and, when the stream is piped, push
   * it as a frame.
   *
   * The frame carries the chunk's raw bytes, so the sequence a consumer
   * assembles is byte-identical to what the child wrote.
   */
  private capture(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const window = stream === 'stdout' ? this.stdout : this.stderr
    window?.push(chunk)
    this.pushPipe(stream, chunk)
  }

  /**
   * Push one frame, or give up on a consumer that stopped draining.
   *
   * Frames stop once the process settles, so the last flush is never truncated
   * and nothing arrives after the client has seen the exit.
   */
  private pushPipe(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.disposed || this.pipeAbandoned || this.settled !== null) return
    if (this.backlog[stream] >= MAX_PIPE_BACKLOG_FRAMES) {
      this.pipeAbandoned = true
      this.terminate()
      return
    }
    const seq = this.sequence[stream]
    this.sequence[stream] = seq + 1
    this.backlog[stream] += 1
    void this.send({ procId: this.procId, stream, seq, data: chunk.toString('base64') })
      .catch(() => {
        // The connection is gone; its whole backend is released with it.
      })
      .then(() => { this.backlog[stream] -= 1 })
  }

  /** Publish the exit facts, bounded by the grace when `close` never arrives. */
  private settle(): void {
    if (this.settled !== null) return
    this.clearTimer('settleTimer')
    this.settled = this.exitFacts ?? { exitCode: null, signal: null }
  }

  /** Whether any member of the managed range is still alive. */
  private groupAlive(): boolean {
    if (this.pid === undefined) return false
    if (process.platform === 'win32') {
      return this.child.exitCode === null && this.child.signalCode === null
    }
    try {
      process.kill(-this.pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM means the group exists but is not ours to signal; anything other
      // than ESRCH is treated the same way rather than reporting a false exit.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /** Signal the managed range, falling back to the direct child. */
  private signal(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return
    if (process.platform === 'win32') {
      try {
        this.child.kill(signal)
      } catch {
        // The child already exited; termination stays idempotent.
      }
      return
    }
    try {
      process.kill(-this.pid, signal)
    } catch {
      try {
        this.child.kill(signal)
      } catch {
        // The group and the child are both gone; termination stays idempotent.
      }
    }
  }

  private clearTimer(name: 'settleTimer' | 'killTimer'): void {
    const timer = this[name]
    if (timer === undefined) return
    clearTimeout(timer)
    this[name] = undefined
  }
}

/** Resolve one candidate path to a regular, executable, canonical file. */
async function canonicalExecutable(candidate: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error: unknown) {
    throw new SubprocessFailure('SP_NOT_FOUND', `cannot resolve "${candidate}": ${describe(error)}`, { cause: error })
  }
  const info = await stat(canonical)
  if (!info.isFile()) {
    throw new SubprocessFailure('SP_NOT_EXECUTABLE', `"${candidate}" is not a regular file`)
  }
  try {
    await access(canonical, fsConstants.X_OK)
  } catch (error: unknown) {
    throw new SubprocessFailure('SP_NOT_EXECUTABLE', `"${candidate}" is not executable`, { cause: error })
  }
  return canonical
}

/** Resolve once the child has spawned, rejecting with the start failure. */
function awaitSpawn(child: ChildProcess, program: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  }).catch((error: unknown) => {
    throw new SubprocessFailure('SP_SPAWN_FAILED', `cannot spawn "${program}": ${describe(error)}`, { cause: error })
  })
}

/** The stdio disposition for stdin. */
function stdinDisposition(mode: WireSpawnSpec['stdin']): 'ignore' | 'pipe' {
  if (mode === 'ignore') return 'ignore'
  return 'pipe'
}

/** The stdio disposition for a piped, collected, or inherited output stream. */
function outputDisposition(mode: WireSpawnSpec['stdout']): 'inherit' | 'pipe' {
  return mode === 'inherit' ? 'inherit' : 'pipe'
}

/** Whether any requested stream spills. */
function needsSpill(
  stdout: WireSpawnSpec['stdout'],
  stderr: WireSpawnSpec['stderr'],
): boolean {
  return [stdout, stderr].some(
    mode => typeof mode === 'object' && mode.spillMaxBytes !== undefined,
  )
}

/**
 * The collected buffer for one stream, or `undefined` when the stream is
 * inherited or piped — a piped stream is pushed as frames and has no window to
 * read, so `sp.readOutput` answers `SP_UNSUPPORTED_STDIO` for it.
 */
function collectBuffer(
  mode: WireSpawnSpec['stdout'],
  spillDirectory: string | undefined,
  stream: 'stdout' | 'stderr',
): StreamBuffer | undefined {
  if (typeof mode !== 'object') return undefined
  const spillPath = spillDirectory === undefined ? undefined : join(spillDirectory, stream)
  return new StreamBuffer(mode, mode.spillMaxBytes === undefined ? undefined : spillPath)
}

/** Wait for a bounded interval. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}
