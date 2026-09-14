/**
 * Resize an allocated PTY, when the execution world exposes a way to.
 *
 * The subprocess seam deliberately stops at allocation, text, foreground
 * groups, and teardown: `SubprocessTerminalHandle` has no resize verb. A
 * provider that can resize therefore publishes the capability beside the seam
 * rather than in it, and this module probes the two shapes that exist:
 *
 * - the routing runtime `dsh-remote-workspace` installs answers `resize`, which
 *   forwards to its node's `term.resize`;
 * - the local provider allocates through node-pty and keeps that process in a
 *   private `terminal` field, which is what its own `LocalTerminalHandle`
 *   would call.
 *
 * A provider that offers neither is not an error — a terminal allocated on a
 * remote node before that node learned to resize keeps the size it was opened
 * with — so the caller reports the fact instead of failing.
 *
 * @module dsh-terminal/host/resize
 */

import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** A PTY that can be told a new size, in columns and rows. */
export interface ResizableTerminal {
  resize(cols: number, rows: number): void | Promise<void>
}

/**
 * Apply a size to one terminal.
 * @param handle - the allocated terminal.
 * @param cols - column count.
 * @param rows - row count.
 * @returns whether the PTY was actually resized.
 */
export async function resizeTerminal(handle: SubprocessTerminalHandle, cols: number, rows: number): Promise<boolean> {
  const candidate = handle as SubprocessTerminalHandle & Partial<ResizableTerminal> & {
    /** The local provider's node-pty process, reachable only at runtime. */
    readonly terminal?: ResizableTerminal | undefined
  }
  if (typeof candidate.resize === 'function') {
    await candidate.resize(cols, rows)
    return true
  }
  const pty = candidate.terminal
  if (pty !== undefined && typeof pty.resize === 'function') {
    pty.resize(cols, rows)
    return true
  }
  return false
}
