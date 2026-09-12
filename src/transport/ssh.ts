/**
 * Running `ssh` non-interactively against one machine.
 *
 * Every way this plugin reaches a machine — the port forward that carries
 * daemon traffic and the one-shot commands that install and start it — shares
 * the same two decisions: the options that keep `ssh` from ever prompting, and
 * the translation of what it wrote on failure into a remedy. Both live here so
 * a change to either reaches every caller.
 *
 * `runSsh` resolves for any normal exit, non-zero included: a command that
 * reports "no" is a result the caller inspects, not an exception. It rejects
 * only when `ssh` could not be started at all or the caller's deadline passed.
 *
 * @module dsh-remote-ssh-worktree/transport/ssh
 */

import { spawn } from 'node:child_process'

/** How to reach a machine's SSH server. */
export interface SshTarget {
  /** `ssh` destination: `user@host`, or a `~/.ssh/config` alias. */
  readonly target: string
  /** SSH port; omitted defers to the operator's `ssh` configuration. */
  readonly sshPort?: number
  /** Identity file; omitted defers to the operator's `ssh` configuration. */
  readonly identityFile?: string
}

/** What one remote command produced. */
export interface SshCommandResult {
  /** Exit status; `0` means the command succeeded. */
  readonly code: number
  /** Everything the command wrote to stdout, UTF-8 decoded. */
  readonly stdout: string
  /** Everything `ssh` and the command wrote to stderr, UTF-8 decoded. */
  readonly stderr: string
}

/** Knobs one command run reads. */
export interface SshRunOptions {
  /** Bytes to write to the remote command's stdin; the stream then closes. */
  readonly input?: Buffer | string
  /** Bound on the whole run, in milliseconds; omitted waits indefinitely. */
  readonly timeoutMs?: number
}

/** The slice of a spawned `ssh` process one command run drives. */
export interface SshProcess {
  /** Resolves with the exit code, or rejects when `ssh` could not start. */
  readonly exited: Promise<number>
  /** Everything written to stdout; complete once `exited` settles. */
  readStdout(): string
  /** Everything written to stderr; complete once `exited` settles. */
  readStderr(): string
  /** Write the input to stdin and close it; no input just closes it. */
  send(input: Buffer | string | undefined): void
  /** Terminate the process. */
  kill(): void
}

/** Starts one `ssh` process; injectable so tests need no binary. */
export type StartSsh = (args: readonly string[]) => SshProcess

/** Overrides {@link runSsh} accepts for its process handling. */
export interface SshRunDeps {
  /** Starts `ssh`; defaults to the real process. */
  readonly start?: StartSsh
}

/**
 * Build the `ssh` options that make a run non-interactive against this target.
 *
 * The SSH port and identity file default to the operator's own configuration,
 * so a `~/.ssh/config` alias reaches the machine exactly as `ssh` itself would.
 * @param target - the machine to reach.
 * @returns the arguments, excluding the subcommand and the destination.
 */
export function sshArgs(target: SshTarget): readonly string[] {
  return [
    // No terminal is attached, so an authentication or host-key prompt would
    // hang until a caller's deadline expired. Fail immediately instead, and
    // let the diagnostic name what the operator must do.
    '-o', 'BatchMode=yes',
    // Without this a forward that cannot bind leaves an ssh process running
    // that forwards nothing, which reads as a healthy connection.
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...target.sshPort === undefined ? [] : ['-p', String(target.sshPort)],
    ...target.identityFile === undefined ? [] : ['-i', target.identityFile],
  ]
}

/**
 * Turn what `ssh` wrote into a reason an operator can act on.
 *
 * The raw text stays in the message: this maps only the failures with a known
 * remedy, and everything else is more useful verbatim than paraphrased.
 * @param target - the destination the run named.
 * @param stderr - everything the process wrote to stderr.
 * @param fallback - what to say when nothing matches, without the raw text.
 * @returns the message to raise.
 */
export function sshFailure(target: string, stderr: string, fallback: string): string {
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
  return `${fallback}${suffix}`
}

/** Start the real `ssh` process for one command run. */
function startSsh(args: readonly string[]): SshProcess {
  const child = spawn('ssh', [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  // A command that never reads stdin closes the pipe early; that is normal and
  // must not surface as an unhandled stream error.
  child.stdin.on('error', () => {})
  return {
    exited: new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve(code ?? 0) })
    }),
    readStdout: () => stdout,
    readStderr: () => stderr,
    send: (input) => { child.stdin.end(input) },
    kill: () => { child.kill('SIGTERM') },
  }
}

/**
 * Run one command on a machine over SSH.
 *
 * Resolves with the exit status, stdout, and stderr for any exit the process
 * reached on its own, a non-zero one included. Rejects only when `ssh` could
 * not be started or `options.timeoutMs` elapsed; in the first case the
 * diagnostic says so, and in the second it carries whatever stderr arrived.
 * @param ssh - the machine to reach.
 * @param command - the command string the remote shell runs.
 * @param options - optional stdin bytes and a deadline.
 * @param deps - an optional process starter, for tests.
 * @returns the exit status and both streams.
 * @throws when `ssh` cannot start or the deadline passes.
 */
export async function runSsh(
  ssh: SshTarget,
  command: string,
  options: SshRunOptions = {},
  deps: SshRunDeps = {},
): Promise<SshCommandResult> {
  const start = deps.start ?? startSsh
  const child = start([...sshArgs(ssh), ssh.target, command])
  child.send(options.input)

  const timeoutMs = options.timeoutMs
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const deadline = timeoutMs === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('timeout'))
      }, timeoutMs)
    })

  try {
    const code = await (deadline === undefined ? child.exited : Promise.race([child.exited, deadline]))
    return { code, stdout: child.readStdout(), stderr: child.readStderr() }
  } catch (error) {
    child.kill()
    if (timedOut) {
      throw new Error(
        `the SSH command on "${ssh.target}" did not finish within ${String(timeoutMs)}ms`,
        { cause: error },
      )
    }
    throw new Error(
      `could not start ssh for "${ssh.target}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
