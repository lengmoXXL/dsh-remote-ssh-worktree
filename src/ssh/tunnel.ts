/**
 * The SSH port forward that carries one machine's daemon traffic.
 *
 * The daemon binds the machine's own loopback, so the host reaches it the way
 * a person would by hand: a local port, a `ssh -L` forward to the daemon's
 * loopback port, and a connection through it. The local port is chosen per
 * connection from whatever the host has free — a fixed port would collide with
 * whatever else the operator runs, and the port is not part of a machine's
 * identity.
 *
 * The host never accepts a host key on the operator's behalf. An unknown key
 * fails the forward with a diagnostic naming the command that would accept it,
 * because this forward grants shell access as the remote user.
 *
 * @module dsh-remote-worktree/ssh/tunnel
 */

import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'

/** How to reach a machine's SSH server. */
export interface SshTarget {
  /** `ssh` destination: `user@host`, or a `~/.ssh/config` alias. */
  readonly target: string
  /** SSH port; omitted defers to the operator's `ssh` configuration. */
  readonly sshPort?: number
  /** Identity file; omitted defers to the operator's `ssh` configuration. */
  readonly identityFile?: string
}

/** One forward to open. */
export interface TunnelSpec {
  /** The machine to reach. */
  readonly ssh: SshTarget
  /** Port the daemon listens on, on the machine's own loopback. */
  readonly remotePort: number
}

/** A live forward. */
export interface Tunnel {
  /** The local port that reaches the machine's daemon. */
  readonly localPort: number
  /** Resolves when the `ssh` process exits, for any reason. */
  readonly exited: Promise<void>
  /** Stop forwarding and reap the process. Idempotent. */
  close(): void
}

/** Knobs a caller may override; tests use them to avoid real processes. */
export interface TunnelDeps {
  /** Binds a free local port. */
  readonly allocatePort?: () => Promise<number>
  /** Starts the forward. */
  readonly start?: (args: readonly string[]) => TunnelProcess
  /** How long the forward may take to accept a connection. */
  readonly readyTimeoutMs?: number
  /** How long to wait between readiness probes. */
  readonly readyPollMs?: number
}

/** The slice of a spawned process this module drives. */
export interface TunnelProcess {
  /** Resolves once the process has exited. */
  readonly exited: Promise<void>
  /** Everything the process wrote to stderr so far, or a promise for it. */
  readonly diagnostics: () => string
  /** Terminate the process. */
  kill(): void
}

/** Default budget for a forward to start accepting connections. */
const READY_TIMEOUT_MS = 15_000

/** Default gap between readiness probes. */
const READY_POLL_MS = 120

/**
 * Resolve a free TCP port on the host.
 *
 * The port is released before it is returned, so a caller racing for it can
 * lose; a forward that loses reports a bind failure rather than silently
 * forwarding nothing.
 * @returns the port number the host had free.
 */
export function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('could not determine a free local port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Build the `ssh` argument vector for one forward.
 * @param spec - the machine and the daemon port to reach.
 * @param localPort - the host port to forward.
 * @returns the arguments, excluding the executable.
 */
export function tunnelArgs(spec: TunnelSpec, localPort: number): readonly string[] {
  return [
    '-N',
    // No terminal is attached, so an authentication or host-key prompt would
    // hang until the readiness budget expired. Fail immediately instead, and
    // let the diagnostic name what the operator must do.
    '-o', 'BatchMode=yes',
    // Without this a forward that cannot bind leaves an ssh process running
    // that forwards nothing, which reads as a healthy connection.
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...spec.ssh.sshPort === undefined ? [] : ['-p', String(spec.ssh.sshPort)],
    ...spec.ssh.identityFile === undefined ? [] : ['-i', spec.ssh.identityFile],
    '-L', `127.0.0.1:${String(localPort)}:127.0.0.1:${String(spec.remotePort)}`,
    spec.ssh.target,
  ]
}

/**
 * Turn what `ssh` wrote into a reason an operator can act on.
 *
 * The raw text stays in the message: this maps only the failures with a known
 * remedy, and everything else is more useful verbatim than paraphrased.
 * @param target - the destination the forward named.
 * @param stderr - everything the process wrote to stderr.
 * @returns the message to raise.
 */
export function tunnelFailure(target: string, stderr: string): string {
  const text = stderr.trim()
  const suffix = text === '' ? '' : `: ${text}`
  if (/host key verification failed/i.test(text)) {
    return `the SSH host key for "${target}" is not known yet; run \`ssh ${target}\` once to verify and accept it${suffix}`
  }
  if (/administratively prohibited/i.test(text)) {
    return `"${target}" refuses TCP forwarding; its sshd needs AllowTcpForwarding yes${suffix}`
  }
  if (/permission denied|no supported authentication/i.test(text)) {
    return `"${target}" rejected the key or agent; check the SSH key and ssh-agent${suffix}`
  }
  if (/could not resolve hostname/i.test(text)) {
    return `"${target}" cannot be resolved; check the SSH destination${suffix}`
  }
  if (/connection refused|connection timed out|no route to host/i.test(text)) {
    return `"${target}" is unreachable over SSH${suffix}`
  }
  return `could not open an SSH forward to "${target}"${suffix}`
}

/** Start the real `ssh` process for one forward. */
function startSsh(args: readonly string[]): TunnelProcess {
  const child = spawn('ssh', [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return {
    exited: new Promise<void>((resolve) => {
      child.once('error', () => { resolve() })
      child.once('exit', () => { resolve() })
    }),
    diagnostics: () => stderr,
    kill: () => { child.kill('SIGTERM') },
  }
}

/** Probe one TCP port on the host's loopback. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => { settle(true) })
    socket.once('error', () => { settle(false) })
  })
}

/** Wait until a port accepts a connection, the process dies, or time runs out. */
async function waitForForward(
  target: string,
  port: number,
  process: TunnelProcess,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let exited = false
  void process.exited.then(() => { exited = true })
  for (;;) {
    if (await probePort(port)) return
    if (exited) throw new Error(tunnelFailure(target, process.diagnostics()))
    if (Date.now() >= deadline) {
      throw new Error(
        `the SSH forward to "${target}" did not start accepting connections within ${String(timeoutMs)}ms`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/**
 * Open a forward from a free host port to one machine's daemon.
 *
 * Resolves once the forward accepts connections, so a caller that receives a
 * tunnel can connect through it immediately. Rejects — after killing the
 * process — when `ssh` refuses, exits, or never becomes ready.
 * @param spec - the machine and the daemon port to reach.
 * @param deps - overrides for tests.
 * @returns the live forward.
 * @throws when the forward could not be established.
 */
export async function openTunnel(spec: TunnelSpec, deps: TunnelDeps = {}): Promise<Tunnel> {
  const allocatePort = deps.allocatePort ?? allocateLocalPort
  const start = deps.start ?? startSsh
  const localPort = await allocatePort()
  const process = start(tunnelArgs(spec, localPort))
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    process.kill()
  }
  try {
    await waitForForward(
      spec.ssh.target,
      localPort,
      process,
      deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
      deps.readyPollMs ?? READY_POLL_MS,
    )
  } catch (error) {
    close()
    // A forward that died says why; a forward that never bound says what it
    // wrote, which is the only clue to which option the operator must change.
    const stderr = process.diagnostics()
    if (stderr !== '' && error instanceof Error) {
      throw new Error(tunnelFailure(spec.ssh.target, stderr), { cause: error })
    }
    throw error
  }
  return { localPort, exited: process.exited, close }
}
