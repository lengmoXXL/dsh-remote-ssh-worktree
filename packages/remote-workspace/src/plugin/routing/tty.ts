/**
 * The routing terminal provider the plugin registers as `ctx.tty`.
 *
 * A working directory decides the machine: one that belongs to a node is served
 * by that node's daemon over the wire, and every other directory by the local
 * provider this plugin composes in an isolated scope. A consumer asks for a
 * terminal in a directory and never asks which machine owns it, exactly as the
 * file, shell, and subprocess routers answer.
 *
 * With no anchor configured every directory is local, so the router is a
 * pass-through to the composed provider.
 *
 * @module dsh-remote-workspace/plugin/routing/tty
 */

import type { TtyHandle, TtyRuntime, TtySpawnRequest } from 'dsh-tty'
import { createRemoteTty } from 'dsh-tty-remote'
import type { TtyWire } from 'dsh-tty-remote'
import type { ChannelLookup, NodeChannel } from '../../remote/client.ts'
import type { TermId } from '../../remote/protocol.ts'
import { asTermId } from '../../remote/protocol.ts'
import type { AnchorRoute } from '../../storage/anchors.ts'
import { classifyPath } from '../../models/routing.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type TtyRuntimeContract = Pick<TtyRuntime, 'spawn'>

/** What the routing terminal provider needs from its owner. */
export interface RoutingTtyDeps {
  /** The composed provider serving every local directory. */
  readonly localTty: TtyRuntime
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
  /** Resolves the live channel for a node; undefined means "not connected". */
  readonly channel: ChannelLookup
}

/**
 * One node's terminal methods, over this plugin's channel.
 *
 * The port takes the daemon's opaque session id as a string; this is where it
 * becomes the branded id the wire contract carries, in the one module that
 * mints it.
 * @param channel - the live node channel.
 * @returns the wire the remote provider drives.
 */
function terminalWire(channel: NodeChannel): TtyWire {
  return {
    spawn: request => channel.request('term.spawn', request),
    read: (termId, fromByte) => channel.request('term.read', { termId: brand(termId), fromByte }),
    // The daemon answers these with an empty object; the port promises nothing
    // back, so the answer is awaited and dropped.
    write: async (termId, data) => { await channel.request('term.write', { termId: brand(termId), data }) },
    resize: async (termId, cols, rows) => {
      await channel.request('term.resize', { termId: brand(termId), cols, rows })
    },
    terminate: async (termId) => { await channel.request('term.terminate', { termId: brand(termId) }) },
    outcome: termId => channel.request('term.outcome', { termId: brand(termId) }),
  }
}

/** Brand one session id as the wire's own. */
function brand(termId: string): TermId {
  return asTermId(termId)
}

/**
 * Build the routing terminal runtime.
 * @param deps - the composed local provider, the live anchors, and channel lookup.
 * @returns an object satisfying the terminal seam, ready for `ctx.provide`.
 */
export function createRoutingTty(deps: RoutingTtyDeps): TtyRuntimeContract {
  return {
    async spawn(request: TtySpawnRequest): Promise<TtyHandle> {
      const route = classifyPath(request.cwd, undefined, deps.anchors())
      if (route.kind === 'local') return await deps.localTty.spawn(request)
      if (route.kind === 'ambiguous') {
        throw new Error(
          `"${route.remotePath}" belongs to more than one node (${route.nodeIds.join(', ')}); `
          + 'address it as node:<id>:<path>',
        )
      }
      const channel = deps.channel(route.nodeId)
      if (channel === undefined) throw new Error(`remote node "${route.nodeId}" is not connected`)
      return await createRemoteTty(terminalWire(channel), { ...request, cwd: route.remotePath })
    },
  }
}
