/**
 * The compiled daemon, started on a random loopback port for one suite.
 *
 * Every e2e suite talks to the binary the plugin actually installs, so a suite
 * cannot pass against an agent that no longer ships.
 *
 * @module tests/e2e/harness
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentBinaryPath } from '../agent-binary.ts'

/** A daemon one suite started. */
export interface TestAgent {
  /** The address the ready line published, host and kernel-assigned port. */
  readonly boundAddress: string
  /** Stop the daemon and remove its token file. Idempotent. */
  close(): Promise<void>
}

/** What one suite supplies; the port is always kernel-assigned. */
export interface TestAgentOptions {
  /** The shared secret every client must present. */
  readonly token: string
  /** Absolute directory relative paths resolve against, when the suite wants one. */
  readonly root?: string
}

/**
 * Start the agent on a random loopback port.
 * @param options - the token and an optional served root.
 * @returns the running daemon.
 * @throws when the binary is missing or the daemon exits before reporting ready.
 */
export async function startAgent(options: TestAgentOptions): Promise<TestAgent> {
  const directory = await mkdtemp(join(tmpdir(), 'drw-agent-'))
  const tokenFile = join(directory, 'token')
  await writeFile(tokenFile, options.token, 'utf8')
  const child = spawn(agentBinaryPath(), [
    '--listen', '127.0.0.1:0',
    '--token-file', tokenFile,
    ...options.root === undefined ? [] : ['--root', options.root],
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const boundAddress = await awaitReady(child)
  return {
    boundAddress,
    async close() {
      child.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Wait for the ready line, rejecting on an early exit. */
function awaitReady(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the agent never reported ready'))
    }, 10_000)
    let buffered = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /ready (\S+)\n/.exec(buffered)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1] as string)
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the agent exited early with ${String(code)}: ${stderr.trim()}`))
    })
  })
}
