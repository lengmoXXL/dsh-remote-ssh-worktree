/**
 * Wire-level tests for the daemon: a real listener, a real socket, and a
 * `vscode-jsonrpc` client speaking the protocol's JSON-RPC methods.
 *
 * @module dsh-remote-agent/tests/server
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node.js'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type {
  NodeInfo,
  SpPipeFrame,
  WireOutcome,
  WireOutputRead,
  WireRepoState,
  WireStat,
  WireTarget,
  WireTextChunk,
  WireWorktree,
  WireWriteOutcome,
} from '../../shared/protocol.ts'
import { PROTOCOL_VERSION, SP_PIPE_NOTIFICATION } from '../../shared/protocol.ts'
import type { RunningServer } from '../src/server.ts'
import { startServer } from '../src/server.ts'

/** Committer identity for fixture commits. */
const IDENTITY: readonly string[] = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test']

/** Run git in a fixture directory and return its stdout. */
async function gitIn(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error === null) resolve(stdout)
      else reject(error)
    })
  })
}

/** Bound port of a server that asked the kernel for one. */
function boundPort(server: RunningServer): number {
  const separator = server.boundAddress.lastIndexOf(':')
  return Number(server.boundAddress.slice(separator + 1))
}

/**
 * Send one request and return the rejection's JSON-RPC code and wire code, or
 * `undefined` values when it unexpectedly succeeded.
 */
async function refusal(
  connection: MessageConnection,
  method: string,
  params: unknown,
): Promise<readonly [number | undefined, string | undefined]> {
  return await connection.sendRequest(method, params).then(
    () => [undefined, undefined] as const,
    (error: { code?: number; data?: { code?: string } }) => [error.code, error.data?.code] as const,
  )
}

/** Poll `probe` until it answers, or fail once the deadline passes. */
async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
  }
}

describe('daemon server', () => {
  let dir: string
  let server: RunningServer
  let port: number
  const connections: MessageConnection[] = []
  const sockets: Socket[] = []

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-server-'))
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-secret',
      root: dir,
      agentVersion: 'test',
    })
    port = boundPort(server)
  })

  after(async () => {
    for (const connection of connections) connection.dispose()
    for (const socket of sockets) socket.destroy()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** Open a client connection to the daemon, tracked for teardown. */
  async function openClient(): Promise<{ connection: MessageConnection; socket: Socket }> {
    const socket = connect({ host: '127.0.0.1', port })
    await once(socket, 'connect')
    const connection = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    // vscode-jsonrpc settles pending requests on `dispose`, not on transport
    // close, so a client that drops this call leaks every in-flight promise.
    socket.on('close', () => { connection.dispose() })
    connection.listen()
    sockets.push(socket)
    connections.push(connection)
    return { connection, socket }
  }

  it('answers node.hello and then serves the fs methods', async () => {
    const { connection } = await openClient()
    const info = await connection.sendRequest('node.hello', {
      protocol: PROTOCOL_VERSION,
      token: 'shared-secret',
    }) as NodeInfo
    assert.equal(info.protocol, PROTOCOL_VERSION)
    assert.equal(info.agentVersion, 'test')
    // Shape only: `terminal.test.ts` pins what the terminal capability is.
    assert.equal(typeof info.capability.pty, 'boolean')
    assert.equal(info.capability.ripgrep, null)
    assert.equal(info.homedir.length > 0, true)

    assert.equal(await connection.sendRequest('fs.stat', { path: join(dir, 'missing') }), null)

    const target = join(dir, 'over-the-wire.txt')
    const written = await connection.sendRequest('fs.writeText', {
      path: target,
      content: 'wire',
      expected: { kind: 'createIfAbsent' },
    }) as WireWriteOutcome
    assert.equal(written.operation, 'create')
    assert.equal(await readFile(target, 'utf8'), 'wire')

    const stat = await connection.sendRequest('fs.stat', { path: target }) as WireStat
    assert.equal(stat.type, 'file')
    assert.equal(stat.size, 4)

    const chunk = await connection.sendRequest('fs.readTextChunk', {
      path: target,
      offset: 0,
      length: 64,
    }) as WireTextChunk
    assert.equal(chunk.text, 'wire')
    assert.equal(chunk.nextOffset, 4)
    assert.equal(chunk.eof, true)

    const rejected = await connection.sendRequest('fs.readTextChunk', { path: target, offset: -1, length: 8 })
      .then(
        () => null,
        (error: { code?: number; data?: { code?: string } }) => [error.code, error.data?.code],
      )
    assert.deepEqual(rejected, [-32602, 'FS_IO_ERROR'])
  })

  it('resolves a not-yet-existing target so a create flow can address it', async () => {
    const { connection } = await openClient()
    await connection.sendRequest('node.hello', { protocol: PROTOCOL_VERSION, token: 'shared-secret' })

    const future = await connection.sendRequest('fs.resolve', {
      path: join(dir, 'nested', 'future.txt'),
    }) as WireTarget
    assert.equal(future.canonicalPath, join(await realpath(dir), 'nested', 'future.txt'))
    assert.equal(await connection.sendRequest('fs.stat', { path: future.canonicalPath }), null)

    const created = await connection.sendRequest('fs.writeText', {
      path: future.canonicalPath,
      content: 'born',
      expected: { kind: 'createIfAbsent' },
    }) as WireWriteOutcome
    assert.equal(created.operation, 'create')
    assert.equal(created.before, null)
    assert.equal(await readFile(future.canonicalPath, 'utf8'), 'born')
  })

  it('refuses a version mismatch with FS_STALE_VERSION and a malformed intent with invalid params', async () => {
    const target = join(dir, 'guarded-over-the-wire.txt')
    await writeFile(target, 'first')
    const { connection } = await openClient()
    await connection.sendRequest('node.hello', { protocol: PROTOCOL_VERSION, token: 'shared-secret' })

    const stale = await connection.sendRequest('fs.writeText', {
      path: target,
      content: 'clobber',
      expected: { kind: 'replaceIfVersion', version: 'not-the-version' },
    }).then(
      () => null,
      (error: { code?: number; data?: { code?: string } }) => [error.code, error.data?.code],
    )
    assert.deepEqual(stale, [-32603, 'FS_STALE_VERSION'])
    assert.equal(await readFile(target, 'utf8'), 'first')

    const malformed = await connection.sendRequest('fs.writeText', {
      path: target,
      content: 'clobber',
      expected: { kind: 'replaceIfVersion' },
    }).then(
      () => null,
      (error: { code?: number; data?: { code?: string } }) => [error.code, error.data?.code],
    )
    assert.deepEqual(malformed, [-32602, 'FS_IO_ERROR'])
  })

  it('serves the git worktree methods over the wire', async () => {
    const repo = join(dir, 'wire-repo')
    await mkdir(repo)
    await gitIn(repo, ['init', '-q'])
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await gitIn(repo, ['add', '.'])
    await gitIn(repo, [...IDENTITY, 'commit', '-q', '-m', 'base'])

    const { connection } = await openClient()
    await connection.sendRequest('node.hello', { protocol: PROTOCOL_VERSION, token: 'shared-secret' })

    const state = await connection.sendRequest('git.repoState', { repoPath: repo }) as WireRepoState
    assert.equal(state.clean, true)
    assert.equal(typeof state.branch, 'string')

    const worktreePath = join(dir, 'wire-wt')
    const created = await connection.sendRequest('git.worktreeAdd', {
      repoPath: repo,
      worktreePath,
      branch: 'wire-branch',
    }) as WireWorktree
    assert.equal(created.branch, 'wire-branch')
    assert.equal(created.main, false)
    assert.equal(created.path, worktreePath)

    const listed = await connection.sendRequest('git.worktreeList', { repoPath: repo }) as readonly WireWorktree[]
    assert.equal(listed.length, 2)
    assert.equal(listed[0]?.main, true)
    assert.equal(listed[1]?.branch, 'wire-branch')

    await connection.sendRequest('git.worktreeRemove', {
      repoPath: repo,
      worktreePath,
      force: false,
    })
    const remaining = await connection.sendRequest('git.worktreeList', { repoPath: repo }) as readonly WireWorktree[]
    assert.equal(remaining.length, 1)

    const deleted = await connection.sendRequest('git.branchDelete', {
      repoPath: repo,
      branch: 'wire-branch',
      force: false,
    })
    assert.deepEqual(deleted, {})
  })

  it('serves the subprocess methods over the wire', async () => {
    const { connection } = await openClient()
    await connection.sendRequest('node.hello', { protocol: PROTOCOL_VERSION, token: 'shared-secret' })

    const started = await connection.sendRequest('sp.spawn', {
      argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir,
      stdin: { data: 'over the wire\n' },
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
      graceMs: 500,
    }) as { procId: string }
    assert.equal(typeof started.procId, 'string')

    await connection.sendRequest('sp.waitForExit', { procId: started.procId })
    const read = await connection.sendRequest('sp.readOutput', {
      procId: started.procId,
      stream: 'stdout',
      fromByte: 0,
    }) as WireOutputRead
    assert.equal(Buffer.from(read.data, 'base64').toString('utf8'), 'over the wire\n')
    assert.equal(read.lossy, false)

    // The close event may still be in flight when waitForExit answers, so the
    // exit facts are polled rather than assumed.
    let outcome = await connection.sendRequest('sp.outcome', { procId: started.procId }) as WireOutcome | null
    for (let attempt = 0; outcome === null && attempt < 50; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 20) })
      outcome = await connection.sendRequest('sp.outcome', { procId: started.procId }) as WireOutcome | null
    }
    assert.equal(outcome?.exitCode, 0)

    const resolved = await connection.sendRequest('sp.resolveExecutable', { command: 'sh' }) as { path: string }
    assert.ok(resolved.path.startsWith('/'))
  })

  it('pushes a piped stream over the wire as sp.pipe notifications', async () => {
    const { connection } = await openClient()
    await connection.sendRequest('node.hello', { protocol: PROTOCOL_VERSION, token: 'shared-secret' })

    const pushed: SpPipeFrame[] = []
    connection.onNotification(SP_PIPE_NOTIFICATION, (frame: SpPipeFrame) => { pushed.push(frame) })

    const started = await connection.sendRequest('sp.spawn', {
      argv: [process.execPath, '-e', "process.stdout.write('piped over the wire')"],
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: { maxBytes: 4096 },
      graceMs: 500,
    }) as { procId: string }

    // A piped stream has no retained window; the bytes only exist as frames.
    const refused = await connection.sendRequest('sp.readOutput', {
      procId: started.procId,
      stream: 'stdout',
      fromByte: 0,
    }).then(
      () => null,
      (error: { data?: { code?: string } }) => error.data?.code,
    )
    assert.equal(refused, 'SP_UNSUPPORTED_STDIO')

    await connection.sendRequest('sp.waitForExit', { procId: started.procId })
    const assembled = await until(
      () => {
        const mine = pushed.filter(frame => frame.procId === started.procId)
        const text = Buffer.concat(mine.map(frame => Buffer.from(frame.data, 'base64'))).toString('utf8')
        return text.length > 0 ? text : undefined
      },
      'the piped bytes to arrive',
    )
    assert.equal(assembled, 'piped over the wire')
    assert.deepEqual(
      pushed.filter(frame => frame.procId === started.procId).map(frame => frame.seq),
      [0],
    )
  })

  it('serves the terminal methods over the wire', async () => {
    const { connection } = await openClient()
    const info = await connection.sendRequest('node.hello', {
      protocol: PROTOCOL_VERSION,
      token: 'shared-secret',
    }) as NodeInfo
    assert.equal(info.capability.pty, true)

    const unknown = await connection.sendRequest('term.outcome', { termId: 'nope' }).then(
      () => null,
      (error: { data?: { code?: string } }) => error.data?.code,
    )
    assert.equal(unknown, 'SP_NO_SUCH_TERMINAL')

    const read = await connection.sendRequest('term.read', { termId: 'nope', fromByte: 0 }).then(
      () => null,
      (error: { data?: { code?: string } }) => error.data?.code,
    )
    assert.equal(read, 'SP_NO_SUCH_TERMINAL')

    const badSignal = await connection.sendRequest('term.signalForeground', {
      termId: 'nope',
      signal: 'SIGUSR1',
    }).then(
      () => null,
      (error: { code?: number; data?: { code?: string } }) => [error.code, error.data?.code],
    )
    assert.deepEqual(badSignal, [-32602, 'FS_IO_ERROR'])

    const badGeometry = await connection.sendRequest('term.spawn', {
      argv: ['/bin/sh'],
      cwd: dir,
      rows: 0,
      cols: 80,
      graceMs: 500,
    }).then(
      () => null,
      (error: { code?: number }) => error.code,
    )
    assert.equal(badGeometry, -32602)
  })

  it('answers a refused handshake with the typed error before closing the socket', async () => {
    const wrongToken = await openClient()
    const wrongTokenClosed = once(wrongToken.socket, 'close', { signal: AbortSignal.timeout(5000) })
    assert.deepEqual(
      await refusal(wrongToken.connection, 'node.hello', { protocol: PROTOCOL_VERSION, token: 'wrong-secret' }),
      [-32600, 'FS_IO_ERROR'],
    )
    await wrongTokenClosed

    const wrongProtocol = await openClient()
    const wrongProtocolClosed = once(wrongProtocol.socket, 'close', { signal: AbortSignal.timeout(5000) })
    assert.deepEqual(
      await refusal(wrongProtocol.connection, 'node.hello', {
        protocol: PROTOCOL_VERSION + 1,
        token: 'shared-secret',
      }),
      [-32600, 'FS_IO_ERROR'],
    )
    await wrongProtocolClosed

    const tooEarly = await openClient()
    const tooEarlyClosed = once(tooEarly.socket, 'close', { signal: AbortSignal.timeout(5000) })
    assert.deepEqual(
      await refusal(tooEarly.connection, 'fs.stat', { path: dir }),
      [-32600, 'FS_IO_ERROR'],
    )
    await tooEarlyClosed
  })
})
