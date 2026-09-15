/**
 * The browser's terminals, and the sockets that carry them.
 *
 * One entry per Sidebar tab, keyed by the tab record's id, and it outlives the
 * body that draws it: the right Sidebar renders only its active tab, so
 * switching tabs unmounts the terminal's React tree, and a terminal that died
 * with its component would lose the shell every time somebody looked at a
 * different tab. Instead the xterm instance, its scrollback, its DOM element,
 * and its socket all live here, the body borrows them for as long as it is
 * mounted, and the record's own abort signal — fired when the tab is closed,
 * not when it is hidden — is what finally tears the entry down. The socket
 * closing is what makes the host kill the shell, so nothing outlives the tab.
 *
 *
 * @module dsh-remote-workspace/plugin/client/terminal/session
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
// Inlined by the build, which has no stylesheet channel to emit it into.
import '@xterm/xterm/css/xterm.css'
import type { ClientFrame, HostFrame } from '../../../terminal/shared/wire.ts'
import { SOCKET_PATH } from '../../../terminal/shared/wire.ts'
import css from './TerminalSurface.module.css'

/** What the status line reports about one terminal. */
export type TerminalState =
  /** Allocated on the host, but the shell has not answered yet. */
  | { readonly kind: 'opening' }
  /** A live shell. */
  | { readonly kind: 'live'; readonly cwd: string; readonly fixedSize: boolean }
  /** The shell exited. */
  | { readonly kind: 'ended'; readonly code: number | null; readonly signal: string | null }
  /** The socket went away without the shell reporting an exit. */
  | { readonly kind: 'closed' }
  /** The host refused to allocate a shell. */
  | { readonly kind: 'failed'; readonly message: string }

/** Everything one mount of a terminal body supplies. */
export interface TerminalMount {
  /** The Sidebar tab record's id, which is the terminal's identity. */
  readonly tabId: string
  /** The Session whose workspace the shell starts in. */
  readonly sessionId: string
  /** The element the terminal is drawn into while the body is mounted. */
  readonly host: HTMLElement
  /** Aborted when the tab record disappears, and only then. */
  readonly signal: AbortSignal
  /** Receives every state change, including the ones that happen while hidden. */
  readonly onState: (state: TerminalState) => void
}

/** One live browser terminal. */
interface Entry {
  readonly tabId: string
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly element: HTMLDivElement
  readonly term: Terminal
  readonly fit: FitAddon
  readonly socket: WebSocket
  readonly observer: ResizeObserver
  /** The element the body is currently drawing into; the entry moves between them. */
  host: HTMLElement
  /** Replaced on every mount, so a remounted body receives the live state. */
  onState: (state: TerminalState) => void
  state: TerminalState
  /** The size last asked of the PTY, which is what an open frame carries. */
  size: { cols: number; rows: number }
  /** Set once a resize was refused, so the layout's staleness is explained rather than guessed at. */
  fixedSize: boolean
}

/** The monospace stack a terminal is drawn in. */
const MONO_FONT = "'SF Mono', 'Menlo', 'DejaVu Sans Mono', 'Cascadia Mono', 'Consolas', 'Liberation Mono', monospace"

/** Scrollback lines one terminal keeps in the browser. */
const SCROLLBACK_LINES = 5000

/** Every terminal this page owns, keyed by tab record id. */
const entries = new Map<string, Entry>()

/** Whether the theme observer is already installed. */
let watchingTheme = false

/**
 * Read the panel's surface colors so the terminal is drawn in the app's theme.
 * @returns an xterm theme derived from the shell's own tokens.
 */
function palette(): ITheme {
  const styles = getComputedStyle(document.body)
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  const ink = dark ? '#e8e8ea' : '#232326'
  const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: read('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
    foreground: read('--dsw-alias-label-primary', ink),
    cursor: read('--dsw-alias-label-primary', ink),
    cursorAccent: read('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
    selectionBackground: read('--dsw-alias-interactive-bg-active', dark ? '#3c3c41' : '#d5d5db'),
  }
}

/** Redraw every terminal after the shell switches theme. */
function watchTheme(): void {
  if (watchingTheme) return
  watchingTheme = true
  new MutationObserver(() => {
    const theme = palette()
    for (const entry of entries.values()) entry.term.options.theme = theme
  }).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
}

/** Publish a state to the mounted body, if any. */
function emit(entry: Entry, state: TerminalState): void {
  entry.state = state
  entry.onState(state)
}

/** Send one control frame, unless the socket is gone. */
function send(entry: Entry, frame: ClientFrame): void {
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify(frame))
}

/** The socket URL for this page's origin. */
function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${SOCKET_PATH}`
}

/** Build a fresh terminal and connect its socket. */
function create(mount: TerminalMount): Entry {
  watchTheme()
  const element = document.createElement('div')
  // The local is declared beside this file; the CSS Modules indexer cannot prove it.
  element.className = css.surface!
  mount.host.appendChild(element)

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: MONO_FONT,
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: SCROLLBACK_LINES,
    macOptionIsMeta: true,
    theme: palette(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(element)

  const observer = new ResizeObserver(() => {
    fit.fit()
  })
  observer.observe(mount.host)

  const socket = new WebSocket(socketUrl())
  socket.binaryType = 'arraybuffer'

  const entry: Entry = {
    tabId: mount.tabId,
    sessionId: mount.sessionId,
    signal: mount.signal,
    element,
    term,
    fit,
    socket,
    observer,
    host: mount.host,
    onState: mount.onState,
    state: { kind: 'opening' },
    size: { cols: term.cols, rows: term.rows },
    fixedSize: false,
  }

  // A size the browser measures before the socket is up is what the open frame
  // asks for; a later one is a real resize. `send` drops the frames that have
  // nowhere to go, so both paths run through the same handler.
  term.onResize(({ cols, rows }) => {
    entry.size = { cols, rows }
    send(entry, { t: 'resize', cols, rows })
  })
  term.onData((data) => {
    send(entry, { t: 'input', data })
  })

  socket.addEventListener('open', () => {
    send(entry, { t: 'open', sessionId: mount.sessionId, cols: entry.size.cols, rows: entry.size.rows })
  })
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data))
      return
    }
    let frame: HostFrame
    try {
      frame = JSON.parse(String(event.data)) as HostFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'ready':
        emit(entry, { kind: 'live', cwd: frame.cwd, fixedSize: entry.fixedSize })
        return
      case 'size':
        entry.fixedSize = !frame.live
        if (entry.state.kind === 'live') emit(entry, { ...entry.state, fixedSize: entry.fixedSize })
        return
      case 'exit':
        emit(entry, { kind: 'ended', code: frame.code, signal: frame.signal })
        return
      case 'error':
        emit(entry, { kind: 'failed', message: frame.message })
        return
      default:
        return
    }
  })
  socket.addEventListener('close', () => {
    if (entry.state.kind === 'opening' || entry.state.kind === 'live') emit(entry, { kind: 'closed' })
  })
  socket.addEventListener('error', () => {
    if (entry.state.kind === 'opening' || entry.state.kind === 'live') emit(entry, { kind: 'closed' })
  })

  // The record disappearing is the only thing that ends a terminal: hiding the
  // tab, switching Session, or collapsing the column all unmount the body
  // without aborting this signal.
  mount.signal.addEventListener('abort', () => {
    dispose(mount.tabId)
  }, { once: true })

  return entry
}

/** Release one terminal: its shell, its socket, and its scrollback. */
function dispose(tabId: string): void {
  const entry = entries.get(tabId)
  if (entry === undefined) return
  entries.delete(tabId)
  entry.observer.disconnect()
  entry.socket.close(1000, 'closed')
  entry.term.dispose()
  entry.element.remove()
}

/**
 * The state of one terminal, for a body that is about to mount.
 * @param tabId - the Sidebar tab record's id.
 * @returns the live state, or the opening state for a tab with no terminal yet.
 */
export function terminalState(tabId: string): TerminalState {
  return entries.get(tabId)?.state ?? { kind: 'opening' }
}

/**
 * Draw one tab's terminal, creating it on first mount.
 * @param mount - the tab, its Session, its element, and its lifetime.
 * @returns the detach function: the terminal survives it, the drawing does not.
 */
export function mountTerminal(mount: TerminalMount): () => void {
  const existing = entries.get(mount.tabId)
  const entry = existing ?? create(mount)
  if (existing === undefined) entries.set(mount.tabId, entry)
  entry.onState = mount.onState
  entry.host = mount.host
  mount.host.appendChild(entry.element)
  entry.observer.observe(mount.host)
  entry.fit.fit()
  entry.term.focus()
  return () => {
    entry.observer.disconnect()
    entry.element.remove()
  }
}

/**
 * Replace one terminal with a fresh one, for a shell that has exited.
 * @param tabId - the Sidebar tab record's id.
 */
export function restartTerminal(tabId: string): void {
  const entry = entries.get(tabId)
  if (entry === undefined) return
  const mount: TerminalMount = {
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    host: entry.host,
    signal: entry.signal,
    onState: entry.onState,
  }
  dispose(tabId)
  const replacement = create(mount)
  entries.set(tabId, replacement)
  replacement.fit.fit()
  replacement.term.focus()
}
