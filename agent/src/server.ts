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
import { asProcId, asTermId } from '../../shared/protocol.ts'
import type { ProcId, TermId,
  NodeInfo,
  WireEditRequest,
  WireErrorData,
  WireFailureCode,
  WireOutputMode,
  WireSpawnSpec,
  WireStdinMode,
  WireTerminalSignal,
  WireTerminalSpawnSpec,
  WireWriteIntent,
} from '../../shared/protocol.ts'
import { PROTOCOL_VERSION, SP_PIPE_NOTIFICATION } from '../../shared/protocol.ts'
import type { FsBackend } from './fs.ts'
import { FsFailure, createFsBackend } from './fs.ts'
import type { GitBackend } from './git.ts'
import { GitFailure, createGitBackend } from './git.ts'
import type { SubprocessBackend } from './subprocess.ts'
import { MAX_GRACE_MS, SubprocessFailure, createSubprocessBackend } from './subprocess.ts'
import type { TerminalBackend } from './terminal.ts'
import { createTerminalBackend } from './terminal.ts'

/** The method implementations one connection dispatches to. */
interface Backends {
  readonly fs: FsBackend
  readonly git: GitBackend
  readonly sp: SubprocessBackend
  readonly term: TerminalBackend
}

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

/** Route one authenticated request onto the backend. */
async function dispatch(method: string, params: unknown, backends: Backends): Promise<unknown> {
  switch (method) {
    case 'fs.resolve': {
      const source = asRecord(params, method)
      return backends.fs.resolve(requireString(source, 'path', method), optionalString(source, 'cwd', method))
    }
    case 'fs.stat': {
      const source = asRecord(params, method)
      return backends.fs.stat(requireString(source, 'path', method))
    }
    case 'fs.lstat': {
      const source = asRecord(params, method)
      return backends.fs.lstat(requireString(source, 'path', method), optionalString(source, 'cwd', method))
    }
    case 'fs.listDir': {
      const source = asRecord(params, method)
      return backends.fs.listDir(requireString(source, 'path', method))
    }
    case 'fs.readTextChunk': {
      const source = asRecord(params, method)
      return backends.fs.readTextChunk(
        requireString(source, 'path', method),
        requireInteger(source, 'offset', method, 0),
        requireInteger(source, 'length', method, 1),
      )
    }
    case 'fs.readBytes': {
      const source = asRecord(params, method)
      return backends.fs.readBytes(
        requireString(source, 'path', method),
        requireInteger(source, 'maxBytes', method, 0),
      )
    }
    case 'fs.readByteRange': {
      const source = asRecord(params, method)
      return backends.fs.readByteRange(
        requireString(source, 'path', method),
        requireInteger(source, 'offset', method, 0),
        requireInteger(source, 'length', method, 0),
      )
    }
    case 'fs.writeText': {
      const source = asRecord(params, method)
      return backends.fs.writeText(
        requireString(source, 'path', method),
        requireString(source, 'content', method),
        readWriteIntent(source['expected'], method),
      )
    }
    case 'fs.editText': {
      const source = asRecord(params, method)
      return backends.fs.editText(
        requireString(source, 'path', method),
        readEditRequest(source['edit'], method),
        readExpectedVersion(source['expected'], method),
      )
    }
    case 'git.worktreeAdd': {
      const source = asRecord(params, method)
      return backends.git.worktreeAdd(
        requireString(source, 'repoPath', method),
        requireString(source, 'worktreePath', method),
        requireString(source, 'branch', method),
        optionalString(source, 'baseRef', method),
      )
    }
    case 'git.worktreeList': {
      const source = asRecord(params, method)
      return backends.git.worktreeList(requireString(source, 'repoPath', method))
    }
    case 'git.worktreeRemove': {
      const source = asRecord(params, method)
      return backends.git.worktreeRemove(
        requireString(source, 'repoPath', method),
        requireString(source, 'worktreePath', method),
        requireBoolean(source, 'force', method),
      )
    }
    case 'git.branchDelete': {
      const source = asRecord(params, method)
      return backends.git.branchDelete(
        requireString(source, 'repoPath', method),
        requireString(source, 'branch', method),
        requireBoolean(source, 'force', method),
      )
    }
    case 'git.repoState': {
      const source = asRecord(params, method)
      return backends.git.repoState(requireString(source, 'repoPath', method))
    }
    case 'git.mergeBranch': {
      const source = asRecord(params, method)
      return backends.git.mergeBranch(
        requireString(source, 'repoPath', method),
        requireString(source, 'branch', method),
      )
    }
    case 'sp.resolveExecutable': {
      const source = asRecord(params, method)
      return backends.sp.resolveExecutable(
        requireString(source, 'command', method),
        readEnvironment(source['env'], method),
      )
    }
    case 'sp.spawn':
      return await backends.sp.spawn(readSpawnSpec(params, method))
    case 'sp.readOutput': {
      const source = asRecord(params, method)
      return backends.sp.readOutput(
        requireProcId(params, method),
        readStreamName(source['stream'], method),
        requireInteger(source, 'fromByte', method, 0),
      )
    }
    case 'sp.writeStdin': {
      const source = asRecord(params, method)
      return backends.sp.writeStdin(
        requireProcId(params, method),
        requireString(source, 'data', method),
      )
    }
    case 'sp.closeStdin':
      return backends.sp.closeStdin(requireProcId(params, method))
    case 'sp.terminate':
      return backends.sp.terminate(requireProcId(params, method))
    case 'sp.waitForExit':
      return await backends.sp.waitForExit(requireProcId(params, method))
    case 'sp.outcome':
      return backends.sp.outcome(requireProcId(params, method))
    case 'term.spawn':
      return await backends.term.spawn(readTerminalSpec(params, method))
    case 'term.read': {
      const source = asRecord(params, method)
      return backends.term.read(
        requireTermId(params, method),
        requireInteger(source, 'fromByte', method, 0),
      )
    }
    case 'term.write': {
      const source = asRecord(params, method)
      return backends.term.write(
        requireTermId(params, method),
        requireString(source, 'data', method),
      )
    }
    case 'term.inspectForeground':
      return await backends.term.inspectForeground(requireTermId(params, method))
    case 'term.signalForeground': {
      const source = asRecord(params, method)
      return await backends.term.signalForeground(
        requireTermId(params, method),
        readTerminalSignal(source['signal'], method),
      )
    }
    case 'term.terminate':
      return await backends.term.terminate(requireTermId(params, method))
    case 'term.outcome':
      return backends.term.outcome(requireTermId(params, method))
    default:
      throw failure('FS_IO_ERROR', `unknown method "${method}"`, ErrorCodes.MethodNotFound)
  }
}

/** Read a required terminal id. */
function requireTermId(params: unknown, method: string): TermId {
  return asTermId(requireString(asRecord(params, method), 'termId', method))
}

/** Read and validate one terminal allocation request. */
function readTerminalSpec(params: unknown, method: string): WireTerminalSpawnSpec {
  const source = asRecord(params, method)
  const argv = source['argv']
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(entry => typeof entry === 'string')) {
    throw invalidParams(method, '"argv" must be a non-empty array of strings')
  }
  const graceMs = requireInteger(source, 'graceMs', method, 1)
  if (graceMs > MAX_GRACE_MS) {
    throw invalidParams(method, `"graceMs" must not exceed ${MAX_GRACE_MS}`)
  }
  const env = readEnvironment(source['env'], method)
  return {
    argv: argv as readonly string[],
    cwd: requireString(source, 'cwd', method),
    rows: requireInteger(source, 'rows', method, 1),
    cols: requireInteger(source, 'cols', method, 1),
    graceMs,
    ...env === undefined ? {} : { env },
  }
}

/** Read and validate one terminal signal name. */
function readTerminalSignal(value: unknown, method: string): WireTerminalSignal {
  switch (value) {
    case 'SIGINT':
    case 'SIGTERM':
    case 'SIGKILL':
    case 'SIGTSTP':
    case 'SIGHUP':
      return value
    default:
      throw invalidParams(method, '"signal" must be one of SIGINT, SIGTERM, SIGKILL, SIGTSTP, SIGHUP')
  }
}

/** Read a required process id. */
function requireProcId(params: unknown, method: string): ProcId {
  return asProcId(requireString(asRecord(params, method), 'procId', method))
}

/** Read and validate a collected stream name. */
function readStreamName(value: unknown, method: string): 'stdout' | 'stderr' {
  if (value === 'stdout' || value === 'stderr') return value
  throw invalidParams(method, '"stream" must be "stdout" or "stderr"')
}

/** Read and validate one spawn request. */
function readSpawnSpec(params: unknown, method: string): WireSpawnSpec {
  const source = asRecord(params, method)
  const argv = source['argv']
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(entry => typeof entry === 'string')) {
    throw invalidParams(method, '"argv" must be a non-empty array of strings')
  }
  const graceMs = requireInteger(source, 'graceMs', method, 1)
  if (graceMs > MAX_GRACE_MS) {
    throw invalidParams(method, `"graceMs" must not exceed ${MAX_GRACE_MS}`)
  }
  const env = readEnvironment(source['env'], method)
  return {
    argv: argv as readonly string[],
    cwd: requireString(source, 'cwd', method),
    stdin: readStdinMode(source['stdin'], method),
    stdout: readOutputMode(source['stdout'], method),
    stderr: readOutputMode(source['stderr'], method),
    graceMs,
    ...env === undefined ? {} : { env },
  }
}

/** Read and validate a stdin disposition. */
function readStdinMode(value: unknown, method: string): WireStdinMode {
  if (value === 'ignore' || value === 'pipe') return value
  if (isPlainObject(value) && typeof value['data'] === 'string') {
    return { data: value['data'] }
  }
  throw invalidParams(method, '"stdin" must be "ignore", "pipe", or { data }')
}

/**
 * Read and validate an output disposition.
 *
 * `'pipe'` is a live push stream carried by {@link SP_PIPE_NOTIFICATION}, not a
 * retained window: a consumer that needs every byte as it arrives asks for it.
 */
function readOutputMode(value: unknown, method: string): WireOutputMode {
  if (value === 'inherit' || value === 'pipe') return value
  if (isPlainObject(value)) {
    const maxBytes = requireInteger(value, 'maxBytes', method, 0)
    const spill = value['spillMaxBytes']
    if (spill === undefined) return { maxBytes }
    return { maxBytes, spillMaxBytes: requireInteger(value, 'spillMaxBytes', method, 0) }
  }
  throw invalidParams(method, '"stdout" and "stderr" must be "inherit" or { maxBytes, spillMaxBytes? }')
}

/** Read and validate an optional environment overlay. */
function readEnvironment(value: unknown, method: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const source = asRecord(value, method)
  const environment: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== 'string') throw invalidParams(method, `"env.${key}" must be a string`)
    environment[key] = entry
  }
  return environment
}

/** Whether a value is a JSON object usable as a field source. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and validate the handshake request. */
function readHello(params: unknown): { readonly protocol: number; readonly token: string } {
  const method = 'node.hello'
  const source = asRecord(params, method)
  const protocol = source['protocol']
  if (typeof protocol !== 'number' || !Number.isSafeInteger(protocol)) {
    throw invalidParams(method, '"protocol" must be a safe integer')
  }
  return { protocol, token: requireString(source, 'token', method) }
}

/** Read and validate a write intent. */
function readWriteIntent(value: unknown, method: string): WireWriteIntent | undefined {
  if (value === undefined) return undefined
  const source = asRecord(value, method)
  const kind = source['kind']
  if (kind === 'createIfAbsent') return { kind: 'createIfAbsent' }
  if (kind === 'replaceIfVersion') {
    return { kind: 'replaceIfVersion', version: requireString(source, 'version', method) }
  }
  throw invalidParams(method, '"expected.kind" must be "createIfAbsent" or "replaceIfVersion"')
}

/** Read and validate a literal edit request. */
function readEditRequest(value: unknown, method: string): WireEditRequest {
  const source = asRecord(value, method)
  const replaceAll = source['replaceAll']
  if (typeof replaceAll !== 'boolean') {
    throw invalidParams(method, '"edit.replaceAll" must be a boolean')
  }
  return {
    oldString: requireString(source, 'oldString', method),
    newString: requireString(source, 'newString', method),
    replaceAll,
  }
}

/** Read and validate the optional expected version. */
function readExpectedVersion(value: unknown, method: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(asRecord(value, method), 'version', method)
}

/** Reject a parameter object that is not a JSON object. */
function asRecord(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidParams(method, 'params must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** Read a required string member. */
function requireString(source: Record<string, unknown>, field: string, method: string): string {
  const value = source[field]
  if (typeof value !== 'string') throw invalidParams(method, `"${field}" must be a string`)
  return value
}

/** Read an optional string member. */
function optionalString(source: Record<string, unknown>, field: string, method: string): string | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidParams(method, `"${field}" must be a string`)
  return value
}

/** Read a required safe integer member at or above `minimum`. */
function requireInteger(
  source: Record<string, unknown>,
  field: string,
  method: string,
  minimum: number,
): number {
  const value = source[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw invalidParams(method, `"${field}" must be a safe integer no smaller than ${minimum}`)
  }
  return value
}

/** Read a required boolean member. */
function requireBoolean(source: Record<string, unknown>, field: string, method: string): boolean {
  const value = source[field]
  if (typeof value !== 'boolean') throw invalidParams(method, `"${field}" must be a boolean`)
  return value
}

/** A malformed-request failure carrying the protocol's error data. */
function invalidParams(method: string, detail: string): ResponseError<WireErrorData> {
  const message = `${method}: ${detail}`
  return new ResponseError(ErrorCodes.InvalidParams, message, { code: 'FS_IO_ERROR', message })
}

/** A daemon failure carrying the protocol's error data. */
function failure(
  code: WireFailureCode,
  message: string,
  rpcCode: number = ErrorCodes.InternalError,
): ResponseError<WireErrorData> {
  return new ResponseError(rpcCode, message, { code, message })
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
