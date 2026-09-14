/**
 * One browser socket, one PTY.
 *
 * The bridge owns the whole correspondence: it resolves the Session's
 * workspace, allocates the terminal through `ctx.subprocess` — which is what
 * makes a routed workspace run its shell on the node that owns it, with no
 * knowledge of machines here — pumps output back as binary frames, and kills
 * the terminal when the socket goes away. Nothing outlives the socket, so a
 * browser that is closed, reloaded, or disconnected leaves no shell behind.
 *
 * Output is paced one chunk at a time: a command that floods the terminal
 * pauses the PTY's output stream until the socket has taken the chunk, instead
 * of queueing the whole flood inside this process.
 *
 * @module dsh-terminal/host/terminal
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { WebSocket, type RawData } from 'ws'
import type { ClientFrame, HostFrame, OpenFrame } from '../shared/wire.ts'
import { resizeTerminal } from './resize.ts'
import { resolveWorkspace } from './workspace.ts'

/** How this deployment starts a shell. */
export interface TerminalSettings {
  /** The program to run, which is the shell the terminal is named after. */
  readonly shell: string
  /** Arguments after the program. */
  readonly shellArgs: readonly string[]
  /** Environment layered onto the provider's ambient scrub. */
  readonly env: Readonly<Record<string, string>>
  /** TERM-to-KILL grace for the whole terminal session, in milliseconds. */
  readonly graceMs: number
}

/** Largest dimension a browser may ask a PTY for. */
const MAX_DIMENSION = 1000

/** Keystrokes held while a shell is still being allocated, before they are dropped. */
const MAX_PENDING_INPUT = 256

/**
 * Clamp a browser-measured dimension into something a PTY accepts.
 * @param value - the measured value.
 * @param fallback - the value to use when the measurement is not a number.
 * @returns a whole number of rows or columns in range.
 */
function dimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(value)))
}

/**
 * Decode one WebSocket text message.
 * @param data - the message as the server delivered it.
 * @returns its UTF-8 text.
 */
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Report a failure the way the browser's status line reads it.
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an Error.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serve one terminal over one accepted socket.
 * @param ctx - the host context carrying `ctx.subprocess`.
 * @param settings - how to start a shell.
 * @param socket - the accepted browser socket.
 */
export function attachTerminal(ctx: Context, settings: TerminalSettings, socket: WebSocket): void {
  let handle: SubprocessTerminalHandle | undefined
  let opening = false
  let closed = false
  /** The size the browser last asked for; the spawn uses it even if it changed mid-allocation. */
  let requested = { cols: 80, rows: 24 }
  /** The size the PTY actually has, so an unchanged resize is not forwarded. */
  let applied: { cols: number; rows: number } | undefined
  const typed: string[] = []

  const post = (frame: HostFrame): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  /** Release the PTY, whether the socket failed or the terminal had already exited. */
  const stop = (): void => {
    if (closed) return
    closed = true
    const current = handle
    handle = undefined
    if (current !== undefined) void current.terminate().catch(() => undefined)
  }

  /** Stream terminal output to the browser, one chunk in flight. */
  const pump = (terminal: SubprocessTerminalHandle): void => {
    terminal.output.on('data', (chunk: Buffer) => {
      if (socket.readyState !== WebSocket.OPEN) return
      terminal.output.pause()
      socket.send(chunk, () => {
        if (!closed) terminal.output.resume()
      })
    })
    void terminal.done.then((outcome) => {
      post({ t: 'exit', code: outcome.exitCode, signal: outcome.signal })
      socket.close(1000, 'terminal exited')
    }, (error: unknown) => {
      post({ t: 'error', message: describe(error) })
      socket.close(1011, 'terminal failed')
    })
  }

  /** Allocate the shell for one Session's workspace. */
  const open = async (frame: OpenFrame): Promise<void> => {
    if (closed) return
    if (handle !== undefined || opening) {
      post({ t: 'error', message: 'this connection already owns a terminal' })
      return
    }
    requested = { cols: dimension(frame.cols, 80), rows: dimension(frame.rows, 24) }
    opening = true
    try {
      const cwd = await resolveWorkspace(ctx, frame.sessionId)
      const terminal = await ctx.subprocess.spawnTerminal({
        argv: [settings.shell, ...settings.shellArgs],
        cwd,
        env: { ...settings.env },
        cols: requested.cols,
        rows: requested.rows,
        graceMs: settings.graceMs,
      })
      // The socket may have gone while the terminal was being allocated; a
      // published handle owns its own lifetime and must be released here.
      if (closed) {
        void terminal.terminate().catch(() => undefined)
        return
      }
      handle = terminal
      applied = { ...requested }
      pump(terminal)
      post({ t: 'ready', pid: terminal.pid, cwd })
      for (const data of typed.splice(0)) {
        void terminal.write(data).catch(() => undefined)
      }
    } catch (error: unknown) {
      post({ t: 'error', message: describe(error) })
    } finally {
      opening = false
    }
  }

  /** Adopt a browser-measured size, now or as the size the shell will start at. */
  const applySize = async (cols: number, rows: number): Promise<void> => {
    const next = {
      cols: dimension(cols, requested.cols),
      rows: dimension(rows, requested.rows),
    }
    requested = next
    const current = handle
    if (current === undefined) return
    if (applied !== undefined && applied.cols === next.cols && applied.rows === next.rows) return
    applied = next
    // A provider that cannot resize is not a failure — the execution world may
    // simply not offer it — so the browser is told the size is stale instead.
    const live = await resizeTerminal(current, next.cols, next.rows).catch(() => false)
    post({ t: 'size', cols: next.cols, rows: next.rows, live })
  }

  socket.on('close', stop)
  socket.on('error', stop)
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    let frame: ClientFrame
    try {
      frame = JSON.parse(textOf(data)) as ClientFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'open':
        void open(frame)
        return
      case 'input': {
        const current = handle
        if (current === undefined) {
          if (typed.length < MAX_PENDING_INPUT) typed.push(frame.data)
          return
        }
        void current.write(frame.data).catch(() => undefined)
        return
      }
      case 'resize':
        void applySize(frame.cols, frame.rows)
        return
      default:
        return
    }
  })
}
