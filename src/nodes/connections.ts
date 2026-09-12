/**
 * Connection lifecycle for configured nodes.
 *
 * One connection per node, owned here: the routers ask for a channel and get
 * either a live one or `undefined`, which is what makes "the machine is
 * offline" a typed failure at the call site instead of a hang.
 *
 * A dropped transport fails in-flight work and is never presented as
 * resumable. Reconnecting establishes a new connection with no carry-over;
 * remote identity alone cannot reconstruct pending calls, output cursors, or
 * process state.
 *
 * @module dsh-remote-ssh-worktree/nodes/connections
 */

import type { NodeChannel } from '../transport/contract.ts'
import type { ConnectOptions, ConnectedNode } from '../transport/client.ts'
import { connectNode } from '../transport/client.ts'
import type { NodeInfo } from '../../shared/protocol.ts'
import type { NodeRecord } from './registry.ts'
import type { NodeId } from '../ids.ts'
import { DEFAULT_FORWARD_TIMEOUT_MS, openTunnel } from '../transport/tunnel.ts'

/** Where one node's connection stands. */
export type NodeState = 'idle' | 'connecting' | 'ready' | 'failed' | 'disconnected'

/** One node's connection state, as a surface may render it. */
export interface NodeStatus {
  readonly nodeId: NodeId
  readonly state: NodeState
  /** Present once the handshake succeeded. */
  readonly info?: NodeInfo
  /**
   * The local port carrying this node's traffic, once a forward is up. Absent
   * for a direct address, which needs no forward.
   */
  readonly localPort?: number
  /** The failure message after a failed attempt or a dropped transport. */
  readonly error?: string
}

/**
 * The address a daemon is reachable at from this host, plus whatever carries
 * the traffic there.
 */
export interface ResolvedTransport {
  /** Host the daemon is reachable at, from this host. */
  readonly host: string
  /** TCP port the daemon is reachable at, from this host. */
  readonly port: number
  /**
   * Resolves when the transport stops carrying traffic, for a transport that
   * can fail on its own. A caller uses it to publish the loss; a direct
   * address never resolves and is closed only by its owner.
   */
  readonly exited?: Promise<void>
  /** Release whatever this transport holds. Idempotent. */
  close(): void
}

/** What the manager needs from its owner. */
export interface NodeConnectionsDeps {
  /** Establishes a connection; injectable so tests need no socket. */
  readonly connect?: (options: ConnectOptions) => Promise<ConnectedNode>
  /**
   * Turn a stored record into an address this host can dial. Defaults to the
   * SSH forward for an `ssh` record and the recorded address for a `direct`
   * one; injectable so tests need neither a network nor an `ssh` binary.
   */
  readonly openTransport?: (record: NodeRecord) => Promise<ResolvedTransport>
  /**
   * Deadline for the daemon handshake once a transport is up. Defaults to
   * {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}; without one an unreachable daemon
   * leaves the attempt pending forever.
   */
  readonly daemonHandshakeTimeoutMs?: number
  /**
   * Budget for an SSH forward to start accepting connections. Defaults to
   * {@link DEFAULT_FORWARD_TIMEOUT_MS}.
   */
  readonly sshForwardTimeoutMs?: number
}

/**
 * How long a handshake may take. Generous enough for a slow forward over a
 * long link, short enough that a daemon which is simply not running is
 * reported rather than waited on. The plugin exposes this as
 * `Config.daemonHandshakeTimeoutMs`; it is the fallback for a caller that
 * composes the manager directly.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * Explain a failed connect attempt in the terms the operator can act on.
 *
 * A `ssh -L` forward binds its local port whether or not anything listens
 * behind it on the machine, so a handshake that times out through a forward
 * means the daemon is absent far more often than it means the network failed.
 * @param record - the machine that was being reached.
 * @param error - the failure the connector raised.
 * @returns the error to record and rethrow.
 */
function describeFailure(record: NodeRecord, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  // Both deadlines the connector enforces mean the same thing here: the
  // socket opened, so something accepted it, but the daemon never spoke.
  if (record.transport.kind === 'ssh' && /timed out connecting to|handshake with .* timed out/.test(message)) {
    return new Error(
      `the SSH forward to "${record.transport.target}" is up, but nothing answered on daemon port ${String(record.remotePort)}; check that the daemon is running there`,
      { cause: error },
    )
  }
  return error instanceof Error ? error : new Error(message)
}

/**
 * Build the default transport opener.
 * @param forwardTimeoutMs - budget for an SSH forward to become ready.
 * @returns an opener that dials a direct address as recorded and opens a
 *   forward for an `ssh` one.
 */
function defaultOpenTransport(
  forwardTimeoutMs: number,
): (record: NodeRecord) => Promise<ResolvedTransport> {
  return async (record) => {
    if (record.transport.kind === 'direct') {
      return {
        host: record.transport.host,
        port: record.transport.port,
        close: () => {},
      }
    }
    const tunnel = await openTunnel(
      { ssh: record.transport, remotePort: record.remotePort },
      { readyTimeoutMs: forwardTimeoutMs },
    )
    return {
      host: '127.0.0.1',
      port: tunnel.localPort,
      exited: tunnel.exited,
      close: () => { tunnel.close() },
    }
  }
}

/** The connection manager. */
export interface NodeConnections {
  /**
   * The live channel for one node.
   * @param nodeId - the record id.
   * @returns the channel, or undefined when the node is not connected.
   */
  channel(nodeId: NodeId): NodeChannel | undefined
  /**
   * One node's connection state.
   * @param nodeId - the record id.
   * @returns the status; `idle` for a node that was never connected.
   */
  status(nodeId: NodeId): NodeStatus
  /** Every node this manager has seen a state for, in insertion order. */
  list(): readonly NodeStatus[]
  /**
   * Connect one node, or return the handshake already in flight or completed.
   * @param record - the node to connect.
   * @returns what the daemon reported about itself.
   * @throws the connection or handshake failure; the node's status records it.
   */
  connect(record: NodeRecord): Promise<NodeInfo>
  /**
   * Close one node's connection. Idempotent.
   * @param nodeId - the record id.
   */
  disconnect(nodeId: NodeId): void
  /** Close every connection. Idempotent. */
  dispose(): void
}

/** One entry in the manager's table. Fields are explicitly nullable, not optional. */
interface Entry {
  state: NodeState
  info: NodeInfo | undefined
  error: string | undefined
  live: ConnectedNode | undefined
  pending: Promise<NodeInfo> | undefined
  transport: ResolvedTransport | undefined
  localPort: number | undefined
}

/**
 * Build the connection manager.
 * @param deps - an optional connection implementation, defaulting to the TCP client.
 * @returns the manager.
 */
export function createNodeConnections(deps: NodeConnectionsDeps = {}): NodeConnections {
  const connect = deps.connect ?? connectNode
  const openTransport = deps.openTransport
    ?? defaultOpenTransport(deps.sshForwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS)
  const handshakeTimeoutMs = deps.daemonHandshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const entries = new Map<NodeId, Entry>()

  const entryFor = (nodeId: NodeId): Entry => {
    const existing = entries.get(nodeId)
    if (existing !== undefined) return existing
    const created: Entry = {
      state: 'idle',
      info: undefined,
      error: undefined,
      live: undefined,
      pending: undefined,
      transport: undefined,
      localPort: undefined,
    }
    entries.set(nodeId, created)
    return created
  }

  /** Publish a terminal state and drop everything the failure invalidates. */
  const fail = (entry: Entry, error: unknown): void => {
    entry.live?.close()
    entry.live = undefined
    entry.pending = undefined
    entry.info = undefined
    // The forward exists only to carry this connection, so a connection that
    // ended must not leave an `ssh` process running behind it.
    entry.transport?.close()
    entry.transport = undefined
    entry.localPort = undefined
    entry.state = 'failed'
    entry.error = error instanceof Error ? error.message : String(error)
  }

  return {
    channel(nodeId) {
      return entries.get(nodeId)?.live?.channel
    },

    status(nodeId) {
      const entry = entries.get(nodeId)
      if (entry === undefined) return { nodeId, state: 'idle' }
      return {
        nodeId,
        state: entry.state,
        ...entry.info === undefined ? {} : { info: entry.info },
        ...entry.localPort === undefined ? {} : { localPort: entry.localPort },
        ...entry.error === undefined ? {} : { error: entry.error },
      }
    },

    list() {
      return [...entries].map(([nodeId, entry]) => ({
        nodeId,
        state: entry.state,
        ...entry.info === undefined ? {} : { info: entry.info },
        ...entry.localPort === undefined ? {} : { localPort: entry.localPort },
        ...entry.error === undefined ? {} : { error: entry.error },
      }))
    },

    async connect(record) {
      const entry = entryFor(record.nodeId)
      if (entry.state === 'ready' && entry.info !== undefined) return entry.info
      if (entry.pending !== undefined) return entry.pending

      entry.state = 'connecting'
      entry.error = undefined
      const attempt = (async (): Promise<NodeInfo> => {
        // The forward comes first: without it there is no address to dial, and
        // its own failure is more specific than a refused connection would be.
        const transport = await openTransport(record)
        entry.transport = transport
        try {
          const live = await connect({
            host: transport.host,
            port: transport.port,
            token: record.token,
            timeoutMs: handshakeTimeoutMs,
          })
          entry.live = live
          entry.info = live.info
          entry.localPort = record.transport.kind === 'ssh' ? transport.port : undefined
          entry.pending = undefined
          entry.state = 'ready'
          // A forward can die while the socket it carried stays open long
          // enough to look healthy. Publish the loss rather than leaving a
          // `ready` node whose every call hangs.
          void transport.exited?.then(() => {
            if (entry.transport !== transport) return
            fail(entry, new Error(`the SSH forward to "${record.title}" closed`))
          })
          return live.info
        } catch (error) {
          const reported = describeFailure(record, error)
          fail(entry, reported)
          throw reported
        }
      })()
      entry.pending = attempt
      return attempt
    },

    disconnect(nodeId) {
      const entry = entries.get(nodeId)
      if (entry === undefined) return
      entry.live?.close()
      entry.live = undefined
      entry.pending = undefined
      entry.info = undefined
      entry.transport?.close()
      entry.transport = undefined
      entry.localPort = undefined
      entry.error = undefined
      entry.state = 'disconnected'
    },

    dispose() {
      for (const entry of entries.values()) {
        entry.live?.close()
        entry.live = undefined
        entry.pending = undefined
        entry.info = undefined
        entry.transport?.close()
        entry.transport = undefined
        entry.localPort = undefined
        entry.state = 'disconnected'
      }
      entries.clear()
    },
  }
}
