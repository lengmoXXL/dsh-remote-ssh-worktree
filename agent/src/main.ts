/**
 * Command-line entry point for `dsh-remote-worktree-agent`.
 *
 * The daemon binds a loopback address by default and refuses any other
 * interface unless the operator passes `--allow-remote`; confidentiality and
 * integrity for a non-loopback listener are the operator's tunnel, not this
 * process's concern.
 *
 * @module dsh-remote-agent/main
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startServer } from './server.ts'

/** Build identity reported in `node.hello`; bump with the published package. */
const AGENT_VERSION = '0.0.1'

const USAGE = `usage: dsh-remote-agent --listen <host:port> --token-file <path> [--root <dir>] [--allow-remote]

  --listen <host:port>   address to bind; the default posture is loopback only
  --token-file <path>    file holding the shared secret every client presents
  --root <dir>           existing directory relative paths resolve against
  --allow-remote         permit a non-loopback listener (provide TLS or a tunnel)
`

/** A fully parsed command line. */
interface AgentConfig {
  /** Interface to bind. */
  readonly host: string
  /** TCP port to bind; 0 asks the kernel for a free one. */
  readonly port: number
  /** File holding the shared secret. */
  readonly tokenFile: string
  /** Directory requested by `--root`, or `undefined`. */
  readonly root: string | undefined
  /** Whether a non-loopback listener was explicitly permitted. */
  readonly allowRemote: boolean
}

/**
 * Parse the daemon's command line.
 * @param argv - arguments after the executable and script.
 * @returns the parsed configuration.
 * @throws Error naming the offending argument when the command line is malformed.
 */
function parseArgs(argv: readonly string[]): AgentConfig {
  let listen: string | undefined
  let tokenFile: string | undefined
  let root: string | undefined
  let allowRemote = false
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--allow-remote') {
      allowRemote = true
      continue
    }
    if (option !== '--listen' && option !== '--token-file' && option !== '--root') {
      throw new Error(`unknown option "${String(option)}"`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${option}`)
    }
    index += 1
    if (option === '--listen') listen = value
    else if (option === '--token-file') tokenFile = value
    else root = value
  }
  if (listen === undefined) throw new Error('--listen is required')
  if (tokenFile === undefined) throw new Error('--token-file is required')
  return { ...parseListen(listen), tokenFile, root, allowRemote }
}

/**
 * Parse a `<host>:<port>` bind address, accepting `[<ipv6>]:<port>`.
 * @param value - the raw `--listen` value.
 * @returns the host and port.
 * @throws Error when the address or port is malformed.
 */
function parseListen(value: string): { readonly host: string; readonly port: number } {
  let host: string
  let portText: string
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1 || value[end + 1] !== ':') throw new Error(`invalid --listen address "${value}"`)
    host = value.slice(1, end)
    portText = value.slice(end + 2)
  } else {
    const separator = value.lastIndexOf(':')
    if (separator <= 0) throw new Error(`--listen must be <host>:<port>, got "${value}"`)
    host = value.slice(0, separator)
    portText = value.slice(separator + 1)
  }
  const port = Number(portText)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --listen port "${portText}"`)
  }
  return { host, port }
}

/**
 * Whether a bind address is reachable only from this machine.
 * @param host - the host half of `--listen`.
 * @returns true for `localhost`, `127.0.0.0/8`, and `::1`.
 */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  if (isIP(host) === 4) return host.startsWith('127.')
  return isIP(host) === 6 && host === '::1'
}

/**
 * Read the shared secret, rejecting an empty file.
 * @param path - the `--token-file` path.
 * @returns the token with surrounding whitespace removed.
 * @throws Error when the file cannot be read or holds only whitespace.
 */
async function readToken(path: string): Promise<string> {
  const token = (await readFile(path, 'utf8')).trim()
  if (token.length === 0) throw new Error(`token file "${path}" is empty`)
  return token
}

/**
 * Canonicalize the served root, requiring it to exist.
 * @param path - the `--root` path.
 * @returns the realpath-normalized absolute directory.
 * @throws Error when the path is relative, missing, or not a directory.
 */
async function readRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`--root must be an absolute path, got "${path}"`)
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`--root "${path}" is not a directory`)
  }
  return canonical
}

/**
 * Run the daemon until its listener stops.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code; 0 once the listener is up.
 */
async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  let config: AgentConfig
  try {
    config = parseArgs(argv)
  } catch (error: unknown) {
    process.stderr.write(`dsh-remote-agent: ${messageOf(error)}\n${USAGE}`)
    return 2
  }
  if (!isLoopbackHost(config.host) && !config.allowRemote) {
    process.stderr.write(
      `dsh-remote-agent: refusing to listen on non-loopback host "${config.host}" without --allow-remote\n`,
    )
    return 2
  }
  try {
    const token = await readToken(config.tokenFile)
    const root = config.root === undefined ? undefined : await readRoot(config.root)
    const server = await startServer({
      host: config.host,
      port: config.port,
      token,
      root,
      agentVersion: AGENT_VERSION,
    })
    const stop = (): void => { void server.close() }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.stdout.write(`dsh-remote-agent ready ${server.boundAddress}\n`)
    return 0
  } catch (error: unknown) {
    process.stderr.write(`dsh-remote-agent: ${messageOf(error)}\n`)
    return 1
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2))
}
