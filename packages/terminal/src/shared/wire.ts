/**
 * The wire between the browser terminal and the host that owns its PTY.
 *
 * Two kinds of frame share one socket, told apart by how WebSocket carries
 * them rather than by a tag inside them:
 *
 * - **text** carries JSON control — opening a terminal, keystrokes, resizes,
 *   and the host's answers to all three;
 * - **binary** carries raw terminal bytes, host to browser only, so a shell's
 *   output is not base64-encoded and re-decoded once per chunk.
 *
 * The socket's whole life is one terminal: the browser keeps it open while the
 * tab exists, and the host kills the PTY when it closes. There is no reattach
 * protocol because there is nothing to reattach to.
 *
 * @module dsh-terminal/shared/wire
 */

/** Where the host serves the terminal socket. */
export const SOCKET_PATH = '/dsh-terminal/ws'

/** The tab type this plugin contributes to the right Sidebar. */
export const TERMINAL_KIND = 'terminal'

/** That type's implementation identity, and the key its body registers under. */
export const TERMINAL_ID = 'dsh-terminal'

/** Open one terminal in a Session's workspace. The first frame a browser sends. */
export interface OpenFrame {
  readonly t: 'open'
  /** The Session whose workspace directory the shell starts in. */
  readonly sessionId: string
  /** Initial column count, from the browser's own measurement. */
  readonly cols: number
  /** Initial row count, from the browser's own measurement. */
  readonly rows: number
}

/** Deliver keystrokes. */
export interface InputFrame {
  readonly t: 'input'
  /** Text to write verbatim; the browser's Enter key arrives as a carriage return. */
  readonly data: string
}

/** Ask the PTY to adopt a new size. */
export interface ResizeFrame {
  readonly t: 'resize'
  readonly cols: number
  readonly rows: number
}

/** Every frame the browser sends. */
export type ClientFrame = OpenFrame | InputFrame | ResizeFrame

/** The terminal is live; the browser may now write to it. */
export interface ReadyFrame {
  readonly t: 'ready'
  /** Top-level process id. */
  readonly pid: number
  /** The workspace directory the shell was started in. */
  readonly cwd: string
}

/** The top-level process exited; the host closes the socket next. */
export interface ExitFrame {
  readonly t: 'exit'
  /** Exit code, or null when a signal ended it. */
  readonly code: number | null
  /** Terminating signal name, or null on a normal exit. */
  readonly signal: string | null
}

/** Opening or running the terminal failed. */
export interface ErrorFrame {
  readonly t: 'error'
  /** Operator-readable reason. */
  readonly message: string
}

/**
 * How a resize settled.
 *
 * `live` is false when the provider refused the resize: a node may still run
 * an agent from before `term.resize` existed, so its terminals keep the size
 * they were opened with. Saying so is the difference between a stale layout
 * and a bug report.
 */
export interface SizeFrame {
  readonly t: 'size'
  readonly cols: number
  readonly rows: number
  readonly live: boolean
}

/** Every frame the host sends. */
export type HostFrame = ReadyFrame | ExitFrame | ErrorFrame | SizeFrame
