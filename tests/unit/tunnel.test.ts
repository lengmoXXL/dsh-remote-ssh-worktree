/**
 * The SSH forward is the only thing standing between a stored record and a
 * reachable daemon, so its cases are about the two ways it can lie: reporting
 * success while forwarding nothing, and failing without saying which option
 * the operator must change.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { TunnelProcess } from '../../src/transport/tunnel.ts'
import { allocateLocalPort, openTunnel, tunnelArgs, tunnelFailure } from '../../src/transport/tunnel.ts'

const SSH = { target: 'build-01' }

test('the forward is a silent, fail-fast, keepalive tunnel to the daemon loopback', () => {
  const args = tunnelArgs({ ssh: SSH, remotePort: 7801 }, 54321)

  assert.deepEqual(args, [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', '127.0.0.1:54321:127.0.0.1:7801',
    'build-01',
  ])
})

test('a configured SSH port and identity file reach the command line', () => {
  const args = tunnelArgs(
    { ssh: { target: 'me@build-01', sshPort: 2222, identityFile: '~/.ssh/id_ed25519' }, remotePort: 9 },
    1000,
  )

  assert.equal(args.at(-1), 'me@build-01')
  assert.equal(args[args.indexOf('-p') + 1], '2222')
  assert.equal(args[args.indexOf('-i') + 1], '~/.ssh/id_ed25519')
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:1000:127.0.0.1:9')
})

test('an omitted SSH port or identity file is left to the operator s configuration', () => {
  const args = tunnelArgs({ ssh: SSH, remotePort: 7801 }, 1)
  assert.equal(args.includes('-p'), false)
  assert.equal(args.includes('-i'), false)
})

test('each known ssh failure names the remedy, and keeps the original text', () => {
  assert.match(tunnelFailure('h', 'Host key verification failed.'), /run `ssh h` once/)
  assert.match(tunnelFailure('h', 'open failed: administratively prohibited'), /AllowTcpForwarding yes/)
  assert.match(tunnelFailure('h', 'Permission denied (publickey).'), /ssh-agent/)
  assert.match(tunnelFailure('h', 'Could not resolve hostname h'), /cannot be resolved/)
  assert.match(tunnelFailure('h', 'connect to host h port 22: Connection refused'), /unreachable/)
})

test('an unrecognised failure keeps the text rather than paraphrasing it', () => {
  const message = tunnelFailure('h', 'something nobody has seen before')
  assert.match(message, /could not open an SSH forward to "h"/)
  assert.match(message, /something nobody has seen before/)
})

test('an empty diagnostic still names the target', () => {
  assert.equal(tunnelFailure('h', '   '), 'could not open an SSH forward to "h"')
})

/** A listener the injected allocator can hand out, standing in for the forward. */
function listeningPort(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => { server.close() } })
    })
  })
}

/** A process stub that never exits on its own. */
function liveProcess(): TunnelProcess & { killed: boolean } {
  const process = {
    killed: false,
    exited: new Promise<void>(() => {}),
    diagnostics: () => '',
    kill() { process.killed = true },
  }
  return process
}

test('the host offers a usable free port', async () => {
  const port = await allocateLocalPort()
  assert.equal(Number.isInteger(port), true)
  assert.equal(port > 0 && port < 65536, true)
  // The probe must release what it bound, so the port can be handed out again.
  const rebind = createServer()
  await new Promise<void>((resolve, reject) => {
    rebind.once('error', reject)
    rebind.listen(port, '127.0.0.1', () => { resolve() })
  })
  await new Promise<void>((resolve) => { rebind.close(() => { resolve() }) })
})

test('a forward that never accepts connections is refused, not reported ready', async () => {
  const process = liveProcess()
  await assert.rejects(
    () => openTunnel(
      { ssh: SSH, remotePort: 7801 },
      { allocatePort: () => Promise.resolve(1), start: () => process, readyTimeoutMs: 30, readyPollMs: 5 },
    ),
    /did not start accepting connections/,
  )
  assert.equal(process.killed, true)
})

test('a forward whose ssh exits is refused with what ssh wrote', async () => {
  const process: TunnelProcess = {
    exited: Promise.resolve(),
    diagnostics: () => 'open failed: administratively prohibited: open failed',
    kill: () => {},
  }
  await assert.rejects(
    () => openTunnel(
      { ssh: { target: 'locked-down' }, remotePort: 7801 },
      { allocatePort: () => Promise.resolve(1), start: () => process, readyTimeoutMs: 200, readyPollMs: 5 },
    ),
    /AllowTcpForwarding yes/,
  )
})

test('a forward that accepts connections resolves with its local port and closes on demand', async () => {
  const listener = await listeningPort()
  const process = liveProcess()
  const tunnel = await openTunnel(
    { ssh: SSH, remotePort: 7801 },
    {
      allocatePort: () => Promise.resolve(listener.port),
      start: () => process,
      readyTimeoutMs: 500,
      readyPollMs: 5,
    },
  )

  assert.equal(tunnel.localPort, listener.port)
  tunnel.close()
  tunnel.close()
  assert.equal(process.killed, true)
  listener.close()
})

test('the forward hands back the ports it was told to use', async () => {
  const listener = await listeningPort()
  let seen: readonly string[] = []
  const tunnel = await openTunnel(
    { ssh: { target: 'me@h', sshPort: 22 }, remotePort: 47801 },
    {
      allocatePort: () => Promise.resolve(listener.port),
      start: (args) => { seen = args; return liveProcess() },
      readyTimeoutMs: 500,
      readyPollMs: 5,
    },
  )

  assert.equal(seen.includes('127.0.0.1:' + String(listener.port) + ':127.0.0.1:47801'), true)
  tunnel.close()
  listener.close()
})
