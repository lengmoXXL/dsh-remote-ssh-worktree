/**
 * The plugin's view of one node connection.
 *
 * The filesystem and subprocess routers depend on this interface rather than
 * on a concrete client, so a test can drive them with a stub and the transport
 * stays replaceable.
 *
 * @module dsh-remote-ssh-worktree/transport/contract
 */

import type { NodeId } from '../ids.ts'
import type { SpPipeFrame, WireErrorData, WireMethod, WireParams, WireResult } from '../protocol.ts'

/** One live connection to a node's daemon. */
export interface NodeChannel {
  /**
   * Round-trip one protocol method.
   * @param method - the wire method name.
   * @param params - that method's parameters.
   * @returns the method result.
   * @throws NodeRequestError when the daemon answers with a typed wire failure,
   *   and a transport error when the connection drops.
   */
  request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>>
  /**
   * Observe the raw chunks the daemon pushes for `'pipe'` streams.
   *
   * A raw piped stream is pushed, not retained, so a consumer that misses a
   * frame has lost those bytes; a caller registers before it spawns the process
   * it cares about. One handler is active at a time, matching the connection's
   * own single notification slot.
   * @param handler - invoked per pushed chunk.
   * @returns a disposer that removes the handler.
   */
  onPipeFrame(handler: (frame: SpPipeFrame) => void): () => void
}

/** A typed failure the daemon reported, carrying the seam's own error code. */
export class NodeRequestError extends Error {
  /** The daemon's structured payload, verbatim. */
  readonly data: WireErrorData

  /**
   * @param data - the daemon's structured error payload.
   */
  constructor(data: WireErrorData) {
    super(`${data.message} (${data.code})`)
    this.name = 'NodeRequestError'
    this.data = data
  }
}

/** Resolves the live channel for one node, or undefined when it is not connected. */
export type ChannelLookup = (nodeId: NodeId) => NodeChannel | undefined
