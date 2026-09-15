/**
 * Which directory a terminal opens in.
 *
 * The browser sends a Session identity and never a path: the workspace is
 * derived on the host from that Session's own header, exactly as every other
 * workspace-scoped reader derives it. A live Session answers from its header; a
 * Session the host is not running — one restored from disk that the browser is
 * still showing — answers from its persisted header.
 *
 * The resulting path is what a terminal is started with, and it is also what
 * makes the machine choice for free: a workspace routed to a
 * dsh-remote-workspace node is named by its local anchor path, so the routing
 * terminal provider resolves that path to the node and runs the shell there.
 * Nothing here needs to know which machines exist.
 *
 * @module dsh-remote-workspace/terminal/host/workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the persistence plugin's Context merge (ctx.sessionPersistence),
// which is how a Session the host is not running still names its workspace.
import type {} from '@deepseek-ai/dsh-session-persistence'

/** A terminal request the host refused. */
export class TerminalFailure extends Error {
  override readonly name = 'TerminalFailure'
}

/**
 * The workspace directory one Session's terminal belongs in.
 * @param ctx - the host context carrying the session store.
 * @param sessionId - the identity the browser supplied.
 * @returns the absolute workspace directory.
 * @throws TerminalFailure when neither a live nor a persisted header names one.
 */
export async function resolveWorkspace(ctx: Context, sessionId: string): Promise<string> {
  if (sessionId.trim() === '') {
    throw new TerminalFailure('no session identity was supplied, so the workspace is unknown')
  }
  const identity = sessionId as SessionId
  // Read rather than injected: the terminal is one surface of a plugin whose
  // activation does not depend on a session store existing.
  const live = ctx.get('sessions')?.get(identity)?.header
  const stored = live === undefined
    ? await ctx.get('sessionPersistence')?.stat(identity)
    : undefined
  const cwd = (live ?? stored?.header)?.cwd
  if (cwd === undefined || cwd === '') {
    throw new TerminalFailure(`session "${sessionId}" is unknown, so its workspace is too`)
  }
  return cwd
}
