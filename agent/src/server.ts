/**
 * JSON-RPC connection handling for the daemon.
 *
 * One `vscode-jsonrpc` connection serves one socket. `node.hello` must be the
 * first request on that socket: a wrong protocol revision, a wrong token, or
 * any other method arriving first is answered with an error and the socket is
 * closed. After a successful handshake the connection serves the `fs.*`,
 * `git.*`, `sp.*`, and `term.*` methods of `shared/protocol.ts`.
 *
 * @module dsh-remote-agent/server
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { homedir } from 'node:os'
import {
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node.js'
import type { NodeInfo, WireErrorData } from '../../shared/protocol.ts'
import { PROTOCOL_VERSION, SP_PIPE_NOTIFICATION } from '../../shared/protocol.ts'
import { FsFailure, createFsBackend } from './fs.ts'
import { GitFailure, createGitBackend } from './git.ts'
import { SubprocessFailure } from './execution.ts'
import { createSubprocessBackend } from './subprocess.ts'
import { createTerminalBackend } from './terminal.ts'
import type { Backends } from './wire.ts'
import { dispatch, failure, readHello } from './wire.ts'

/** The backends shared by every connection; process and terminal state is per connection. */
type SharedBackends = Omit<Backends, 'sp' | 'term'>

/** Everything `startServer` needs to accept and authenticate connections. */
export interface ServerOptions {
  /** Interface to bind; the caller has already applied the loopback policy. */
  readonly host: string
  /** TCP port to bind; 0 asks the kernel for a free one. */
  readonly port: number
  /** Shared secret every `node.hello` must present. */
  readonly token: string
  /** Absolute default base for relative paths, or `undefined` to reject them. */
  readonly root: string | undefined
  /** Build identity reported in the handshake answer. */
  readonly agentVersion: string
}

/** A listening daemon owning every connection it accepted. */
export interface RunningServer {
  /** Actually bound address, with the kernel-assigned port when 0 was requested. */
  readonly boundAddress: string
  /**
   * Stop listening and drop every open connection.
   * @returns a promise that settles once the listener is closed.
   */
  close(): Promise<void>
}

/**
 * Begin accepting connections.
 * @param options - bind address, token, served root, and build identity.
 * @returns the running daemon.
 * @throws the listener's error, such as `EADDRINUSE`, when the bind fails.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const shared: SharedBackends = {
    fs: createFsBackend(options.root),
    git: createGitBackend(options.root),
  }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serveSocket(socket, options, shared)
  })
  server.on('error', (error: Error) => { report('listener', error) })
  await listen(server, options)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('dsh-remote-agent: the listener did not bind a TCP address')
  }
  return {
    boundAddress: formatHostPort(address),
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

/** Resolve once the listener is bound, rejecting on the first bind error. */
function listen(server: Server, options: ServerOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(options.port, options.host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/** Attach one JSON-RPC connection to one accepted socket. */
function serveSocket(socket: Socket, options: ServerOptions, shared: SharedBackends): void {
  socket.setNoDelay(true)
  const writer = new StreamMessageWriter(socket)
  const write = writer.write.bind(writer)
  let closeAfterWrite = false
  // The connection writes its response asynchronously, so ending the socket
  // when a handshake is refused would drop that response. Defer the close to
  // the write that carries it.
  writer.write = message => {
    const written = write(message)
    if (closeAfterWrite) {
      closeAfterWrite = false
      void written.then(() => { socket.end() }, () => { socket.destroy() })
    }
    return written
  }
  const connection = createMessageConnection(new StreamMessageReader(socket), writer)
  const term = createTerminalBackend()
  const sp = createSubprocessBackend(
    frame => connection.sendNotification(SP_PIPE_NOTIFICATION, frame),
  )
  const backends: Backends = { ...shared, sp, term }
  // A connection owns the process ranges and terminals it started: once its
  // socket is gone they are killed and their buffers released.
  socket.on('close', () => { sp.close(); term.close() })
  let greeted = false
  let refused = false

  /** Reject a handshake and close the socket once the error response is written. */
  const refuse = (message: string): ResponseError<WireErrorData> => {
    refused = true
    closeAfterWrite = true
    return new ResponseError(ErrorCodes.InvalidRequest, message, { code: 'FS_IO_ERROR', message })
  }

  connection.onRequest(async (method: string, params: unknown) => {
    if (refused) throw failure('FS_IO_ERROR', 'the connection was closed after a failed handshake')
    if (!greeted) {
      if (method !== 'node.hello') throw refuse('node.hello must be the first request')
      const hello = readHello(params)
      if (hello.protocol !== PROTOCOL_VERSION) {
        throw refuse(`protocol ${hello.protocol} is not supported; this daemon speaks ${PROTOCOL_VERSION}`)
      }
      if (!tokenMatches(options.token, hello.token)) throw refuse('invalid token')
      greeted = true
      return nodeInfo(options)
    }
    try {
      return await dispatch(method, params, backends)
    } catch (error: unknown) {
      throw toResponseError(error)
    }
  })
  // A wire fault or a reset mid-frame must not leave a desynchronized
  // connection serving requests.
  connection.onError(() => { socket.destroy() })
  socket.on('error', () => { socket.destroy() })
  connection.listen()
}

/** Map a backend failure onto the error response the plugin reads. */
function toResponseError(error: unknown): ResponseError<WireErrorData> {
  if (error instanceof ResponseError) return error as ResponseError<WireErrorData>
  if (error instanceof FsFailure || error instanceof GitFailure || error instanceof SubprocessFailure) {
    return failure(error.code, error.message)
  }
  return failure('FS_IO_ERROR', error instanceof Error ? error.message : String(error))
}

/** The daemon's identity and capabilities for one successful handshake. */
function nodeInfo(options: ServerOptions): NodeInfo {
  return {
    protocol: PROTOCOL_VERSION,
    agentVersion: options.agentVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    homedir: homedir(),
    capability: { pty: true, spill: false, ripgrep: null },
  }
}

/** Compare the presented token with the configured one in constant time. */
function tokenMatches(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) {
    // Compare the expected token with itself so the work does not reveal the
    // presented length, then reject.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}


/** Render `host:port`, bracketing an IPv6 literal. */
function formatHostPort(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return `${host}:${address.port}`
}

/** Report a daemon-level failure without ending the process. */
function report(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-remote-agent: ${context}: ${detail}\n`)
}
