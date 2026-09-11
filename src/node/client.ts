/**
 * The TCP transport to one node's daemon.
 *
 * `vscode-jsonrpc` owns framing, request correlation, and cancellation on top
 * of the socket, so this module only establishes the connection, performs the
 * handshake, and translates a daemon failure into {@link NodeRequestError}.
 *
 * @module dsh-remote-worktree/node/client
 */

import { Socket } from 'node:net'
// The `.js` suffix is required: this package ships no `exports` map, so an
// extensionless subpath is not resolvable from ESM even though the file is.
import { ResponseError, StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node.js'
import type { NodeInfo, SpPipeFrame, WireErrorData, WireMethod, WireParams, WireResult } from '../../shared/protocol.ts'
import { PROTOCOL_VERSION, SP_PIPE_NOTIFICATION } from '../../shared/protocol.ts'
import type { NodeChannel } from './channel.ts'
import { NodeRequestError } from './channel.ts'

/** How to reach one daemon. */
export interface ConnectOptions {
  /** Host or IP the daemon listens on. */
  readonly host: string
  /** TCP port the daemon listens on. */
  readonly port: number
  /** Shared secret from the daemon's token file. */
  readonly token: string
  /** Bound on connection establishment and the handshake, in milliseconds. */
  readonly timeoutMs?: number
}

/** A live, handshaken connection. */
export interface ConnectedNode {
  /** The channel the routers call. */
  readonly channel: NodeChannel
  /** What the daemon reported about itself. */
  readonly info: NodeInfo
  /** Close the connection and release the socket. Idempotent. */
  close(): void
}

/** Whether an unknown value is the daemon's structured failure payload. */
function isWireErrorData(value: unknown): value is WireErrorData {
  return typeof value === 'object' && value !== null
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Translate a `vscode-jsonrpc` rejection into the plugin's typed failure.
 * @param error - whatever the connection raised.
 * @returns the error to reject with.
 */
function toChannelError(error: unknown): unknown {
  if (error instanceof ResponseError && isWireErrorData(error.data)) {
    return new NodeRequestError(error.data)
  }
  return error
}

/**
 * Settle `work` or fail once the deadline passes.
 *
 * The handshake needs its own bound: a daemon that closes the socket without
 * answering leaves the request pending forever, and "the machine answered
 * nothing" must be a failure rather than a hang.
 * @param work - the operation to bound.
 * @param timeoutMs - the deadline, or undefined to wait indefinitely.
 * @param onTimeout - builds the failure to reject with.
 * @returns the operation's result.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => Error,
): Promise<T> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Connect to a daemon and complete the handshake.
 * @param options - address, token, and optional timeout.
 * @returns the live connection, already past `node.hello`.
 * @throws when the socket fails, the handshake times out, or the daemon
 *   refuses the protocol revision or the token.
 */
export async function connectNode(options: ConnectOptions): Promise<ConnectedNode> {
  const socket = new Socket()
  socket.setNoDelay(true)

  await new Promise<void>((resolve, reject) => {
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        socket.destroy()
        reject(new Error(`timed out connecting to ${options.host}:${String(options.port)}`))
      }, options.timeoutMs)
    const settle = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.off('error', onError)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onError = (error: Error): void => settle(error)
    socket.once('error', onError)
    socket.once('connect', () => settle())
    socket.connect({ host: options.host, port: options.port })
  })

  const connection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  connection.listen()

  const channel: NodeChannel = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>> {
      try {
        return await connection.sendRequest<WireResult<M>>(method, params)
      } catch (error) {
        throw toChannelError(error)
      }
    },
    onPipeFrame(handler) {
      // `vscode-jsonrpc` keeps one notification handler per method, which is
      // exactly the lifetime this seam wants: the caller owns registration and
      // disposes it when its process is gone.
      connection.onNotification(SP_PIPE_NOTIFICATION, (frame: SpPipeFrame) => {
        handler(frame)
      })
      return () => {
        connection.onNotification(SP_PIPE_NOTIFICATION, () => {})
      }
    },
  }

  let info: NodeInfo
  try {
    info = await withTimeout(
      channel.request('node.hello', { protocol: PROTOCOL_VERSION, token: options.token }),
      options.timeoutMs,
      () => new Error(`handshake with ${options.host}:${String(options.port)} timed out`),
    )
  } catch (error) {
    connection.dispose()
    socket.destroy()
    throw toChannelError(error)
  }

  let closed = false
  return {
    channel,
    info,
    close() {
      if (closed) return
      closed = true
      connection.dispose()
      socket.destroy()
    },
  }
}
