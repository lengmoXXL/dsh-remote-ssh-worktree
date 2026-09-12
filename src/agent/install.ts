/**
 * Ensure the right agent is installed and running on one machine.
 *
 * A machine is configured by its SSH destination and a token, nothing else:
 * the plugin resolves the platform, downloads the matching binary if this
 * machine does not already run the expected build, uploads it over the same
 * SSH connection, and starts it detached. The agent then binds a random
 * loopback port and publishes it in `state.json`, which is where the forward
 * learns where to point.
 *
 * Reuse is decided from that state file alone: a live process running the
 * expected build is left untouched, and the caller's own handshake is the real
 * liveness check, so this module never opens a TCP probe from the host.
 *
 * Every remote snippet below is shaped for the same three reasons: bytes the
 * plugin owns travel on stdin rather than in the command string, where shell
 * quoting would mangle them and a token would become visible in `ps`; the
 * agent's stdio is redirected away from the SSH channel so `ssh` does not wait
 * on a process meant to outlive it; and `setsid`/`nohup` detach that process
 * from a session that is about to end.
 *
 * @module dsh-remote-ssh-worktree/agent/install
 */

import { agentAssetName, resolveAgentBinary } from './release.ts'
import type { AgentBinaryOptions } from './release.ts'
import type { SshCommandResult, SshTarget } from '../transport/ssh.ts'
import { runSsh, sshFailure } from '../transport/ssh.ts'

/** A started agent, and where a forward can reach it. */
export interface AgentEndpoint {
  /** Loopback port the agent published. */
  readonly port: number
  /** Agent build the endpoint runs. */
  readonly version: string
  /** Whether an agent already running the expected build was left alone. */
  readonly reused: boolean
}

/** Runs one remote command; injectable so tests need no `ssh` process. */
export type AgentCommandRunner = (
  ssh: SshTarget,
  command: string,
  options?: { readonly input?: Buffer | string; readonly timeoutMs?: number },
) => Promise<SshCommandResult>

/** What {@link ensureAgent} needs from its caller. */
export interface EnsureAgentOptions {
  /** The machine to install onto. */
  readonly ssh: SshTarget
  /** Shared secret the agent authenticates callers with. */
  readonly token: string
  /** Agent build to install and run. */
  readonly version: string
  /** Host directory holding cached agent binaries. */
  readonly cacheDir: string
  /** Command runner; defaults to {@link runSsh}. */
  readonly run?: AgentCommandRunner
  /** Binary resolver; defaults to {@link resolveAgentBinary}. */
  readonly resolveBinary?: (options: AgentBinaryOptions) => Promise<Buffer>
  /** Receives progress lines; omitted stays silent. */
  readonly log?: (message: string) => void
  /** Budget for a fresh agent to publish its state, in milliseconds. */
  readonly startTimeoutMs?: number
  /** Gap between state-file polls, in milliseconds. */
  readonly pollMs?: number
}

/**
 * How long a freshly started agent may take to publish `state.json`. Generous
 * enough for a slow link, short enough that a binary that cannot exec is
 * reported rather than waited on.
 */
export const DEFAULT_AGENT_START_TIMEOUT_MS = 10_000

/** Default gap between state-file polls. */
const START_POLL_MS = 120

/**
 * Read the state file; `|| true` keeps a machine that has never run the agent
 * from reading as a failed command, which is an expected state, not an error.
 */
const READ_STATE = 'cat "$HOME/.dsh/remote-agent/state.json" 2>/dev/null || true'

/** Read the plugin's own marker for which build it installed. */
const READ_INSTALLED = 'cat "$HOME/.dsh/remote-agent/installed.json" 2>/dev/null || true'

/** Seed the agent directory before anything is written into it. */
const ENSURE_DIR = 'mkdir -p "$HOME/.dsh/remote-agent"'

/**
 * Replace the binary through a temp name, so a crash or a killed connection
 * never leaves a half-written executable in place, and stamp the executable
 * bit. The bytes arrive on stdin: a buffer interpolated into the command would
 * be mangled by the remote shell.
 */
const UPLOAD_BINARY = 'cat > "$HOME/.dsh/remote-agent/dsh-remote-agent.new"'
  + ' && chmod 755 "$HOME/.dsh/remote-agent/dsh-remote-agent.new"'
  + ' && mv "$HOME/.dsh/remote-agent/dsh-remote-agent.new" "$HOME/.dsh/remote-agent/dsh-remote-agent"'

/** Record which build the step above installed, so a version bump reinstalls. */
const WRITE_INSTALLED = 'cat > "$HOME/.dsh/remote-agent/installed.json"'

/** Write the secret on stdin too, and keep it owner-only. */
const WRITE_TOKEN = 'cat > "$HOME/.dsh/remote-agent/token" && chmod 600 "$HOME/.dsh/remote-agent/token"'

/**
 * Start the agent detached from the SSH session: `setsid` gives it a session
 * of its own where the machine has it, `nohup` survives the hangup either way,
 * every stream goes to the log or `/dev/null` so `ssh` does not wait on a
 * process that is meant to outlive it, and `exit 0` keeps a successful
 * backgrounding from reading as a failed command.
 */
const START_AGENT = 'cd "$HOME/.dsh/remote-agent"'
  + ' && if command -v setsid >/dev/null 2>&1; then'
  + ' setsid nohup ./dsh-remote-agent --listen 127.0.0.1:0 --token-file token --state-file state.json >>agent.log 2>&1 </dev/null &'
  + ' else nohup ./dsh-remote-agent --listen 127.0.0.1:0 --token-file token --state-file state.json >>agent.log 2>&1 </dev/null & fi; exit 0'

/** The subset of the agent's published state this module reads. */
interface AgentState {
  readonly pid: number
  readonly port: number
  readonly version: string
}

/**
 * Parse the agent's state file.
 * @param stdout - the file's contents, or empty when it is absent.
 * @returns the fields a reuse decision needs, or undefined when unusable.
 */
function parseState(stdout: string): AgentState | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Record<string, unknown>
  const { pid, port, version } = state
  if (typeof version !== 'string' || version === '') return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  return { pid, port, version }
}

/** Read and parse the state file. */
async function readState(
  run: AgentCommandRunner,
  ssh: SshTarget,
): Promise<AgentState | undefined> {
  const result = await run(ssh, READ_STATE)
  return parseState(result.stdout)
}

/**
 * Run one command the install cannot continue without, and fail with the
 * shared SSH diagnostic rather than letting a silent non-zero exit surface
 * later as an unexplained timeout.
 * @param run - the command runner.
 * @param ssh - the machine to reach.
 * @param command - the command string to run.
 * @param fallback - what to say when the failure has no known remedy.
 * @param input - optional stdin bytes.
 * @throws when the command exits non-zero.
 */
async function runChecked(
  run: AgentCommandRunner,
  ssh: SshTarget,
  command: string,
  fallback: string,
  input?: Buffer | string,
): Promise<void> {
  const result = await (input === undefined ? run(ssh, command) : run(ssh, command, { input }))
  if (result.code !== 0) throw new Error(sshFailure(ssh.target, result.stderr, fallback))
}

/** Read the version marker the plugin writes beside the binary. */
async function installedVersion(
  run: AgentCommandRunner,
  ssh: SshTarget,
): Promise<string | undefined> {
  const result = await run(ssh, READ_INSTALLED)
  if (result.code !== 0) return undefined
  try {
    const marker = JSON.parse(result.stdout) as { version?: unknown }
    return typeof marker.version === 'string' ? marker.version : undefined
  } catch {
    return undefined
  }
}

/** Whether a process id is still alive on the machine, best effort. */
async function isAlive(
  run: AgentCommandRunner,
  ssh: SshTarget,
  pid: number,
): Promise<boolean> {
  try {
    return (await run(ssh, `kill -0 ${String(pid)}`)).code === 0
  } catch {
    return false
  }
}

/**
 * Ensure the agent is installed and running on one machine.
 * @param options - the machine, token, version, cache, and optional seams.
 * @returns the port and build the machine's agent is serving on.
 * @throws when the platform cannot be resolved, the binary cannot be fetched,
 *   a remote command fails, or a started agent never publishes its state.
 */
export async function ensureAgent(options: EnsureAgentOptions): Promise<AgentEndpoint> {
  const run = options.run ?? runSsh
  const resolveBinary = options.resolveBinary ?? resolveAgentBinary
  const log = options.log ?? (() => {})
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS
  const pollMs = options.pollMs ?? START_POLL_MS
  const { ssh, token, version, cacheDir } = options

  // The platform is read once per call: every branch below either returns or
  // installs, so a second round trip would buy nothing.
  const uname = await run(ssh, 'uname -s; uname -m')
  if (uname.code !== 0) {
    throw new Error(
      sshFailure(ssh.target, uname.stderr, `could not read the platform of "${ssh.target}"`),
    )
  }
  const [platform, arch] = uname.stdout.split('\n')
  const assetName = agentAssetName(platform?.trim() ?? '', arch?.trim() ?? '')

  const state = await readState(run, ssh)
  // A pid that does not answer `kill -0` is a stale state file, not a running
  // agent; a pid that does is a process the install below must replace.
  const stalePid = state !== undefined && await isAlive(run, ssh, state.pid) ? state.pid : undefined
  if (state !== undefined && stalePid === state.pid && state.version === version) {
    log(`reusing dsh-remote-agent ${version} on ${ssh.target} at 127.0.0.1:${String(state.port)}`)
    return { port: state.port, version, reused: true }
  }

  await runChecked(run, ssh, ENSURE_DIR, `could not create ~/.dsh/remote-agent on "${ssh.target}"`)

  if (await installedVersion(run, ssh) !== version) {
    log(`installing dsh-remote-agent ${version} on ${ssh.target} (${assetName})`)
    const binary = await resolveBinary({ version, assetName, cacheDir })
    await runChecked(
      run,
      ssh,
      UPLOAD_BINARY,
      `could not install the agent binary on "${ssh.target}"`,
      binary,
    )
    await runChecked(
      run,
      ssh,
      WRITE_INSTALLED,
      `could not record the installed agent version on "${ssh.target}"`,
      JSON.stringify({ version }),
    )
  }

  // The token is rewritten on every install path, so rotating it in the plugin
  // is enough to rotate it on the machine.
  await runChecked(run, ssh, WRITE_TOKEN, `could not write the agent token on "${ssh.target}"`, token)

  if (stalePid !== undefined) {
    // Best effort: the process is being replaced, and a kill that races its
    // own exit must not fail an install that is otherwise fine.
    await run(ssh, `kill ${String(stalePid)}`).catch(() => {})
  }

  await runChecked(run, ssh, START_AGENT, `could not start the agent on "${ssh.target}"`)

  const deadline = Date.now() + startTimeoutMs
  for (;;) {
    const published = await readState(run, ssh).catch(() => undefined)
    if (published !== undefined && published.version === version && published.port > 0) {
      log(`started dsh-remote-agent ${version} on ${ssh.target} at 127.0.0.1:${String(published.port)}`)
      return { port: published.port, version, reused: false }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the agent on "${ssh.target}" did not publish a port within ${String(startTimeoutMs)}ms; `
        + 'check ~/.dsh/remote-agent/agent.log on the machine',
      )
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}
