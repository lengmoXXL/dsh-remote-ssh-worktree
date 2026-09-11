/**
 * The shipped artifact, not the source.
 *
 * Every other daemon test imports `agent/src/*.ts`; this one runs the built
 * bundle the way an operator would — a child process started from `lib/`, a
 * ready line on stdout, a handshake, and one command through the wire. A
 * bundle that dropped a module, lost its shebang, or externalized the wrong
 * dependency passes every source test and fails here.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectNode } from '../src/node/client.ts'
import type { ConnectedNode } from '../src/node/client.ts'
import type { AnchorRoute } from '../src/routing/classify.ts'
import { createRoutingSubprocessRuntime } from '../src/routing/subprocess.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'agent', 'lib', 'main.mjs')

const TOKEN = 'built-agent-token-0123456789'

let remoteRoot: string
let anchorRoot: string
let tokenFile: string
let child: ReturnType<typeof spawn> | undefined
let node: ConnectedNode

/** Wait for the ready line and return the bound port. */
function awaitReady(process_: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the built daemon never reported ready')), 10_000)
    let buffered = ''
    process_.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /ready 127\.0\.0\.1:(\d+)/.exec(buffered)
      if (match === null) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
    process_.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    process_.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the built daemon exited early with ${String(code)}`))
    })
  })
}

before(async () => {
  assert.equal(existsSync(bundlePath), true, 'run `npm run build:agent` before this suite')

  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-built-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-built-anchor-')))
  await writeFile(join(remoteRoot, 'payload.txt'), 'from the built daemon\n', 'utf8')

  tokenFile = join(await mkdtemp(join(tmpdir(), 'drw-built-token-')), 'token')
  await writeFile(tokenFile, TOKEN, 'utf8')

  child = spawn(process.execPath, [
    bundlePath,
    '--listen', '127.0.0.1:0',
    '--token-file', tokenFile,
    '--root', remoteRoot,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const port = await awaitReady(child)
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })
})

after(async () => {
  node?.close()
  child?.kill('SIGKILL')
  await rm(remoteRoot, { recursive: true, force: true })
  await rm(anchorRoot, { recursive: true, force: true })
  await rm(dirname(tokenFile), { recursive: true, force: true })
})

test('the built daemon completes a handshake', () => {
  assert.equal(node.info.protocol, 1)
  assert.equal(typeof node.info.agentVersion, 'string')
})

test('a command runs through the built daemon and its output returns', async () => {
  const anchors: AnchorRoute[] = [{ nodeId: 'n1', anchorPath: anchorRoot, remoteRoot }]
  const runtime = createRoutingSubprocessRuntime({
    localProc: new Proxy({}, {
      get: () => () => {
        throw new Error('the local delegate was reached')
      },
    }) as unknown as SubprocessRuntime,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? node.channel : undefined),
  })

  const handle = runtime.spawn({
    argv: ['bash', '-c', 'pwd && cat payload.txt'],
    cwd: anchorRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 2000,
  })
  await handle.done

  const output = handle.collected.stdout?.readFrom(0).text ?? ''
  assert.match(output, new RegExp(remoteRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(output, /from the built daemon/)
})

test('the filesystem half works through the built daemon too', async () => {
  const resolved = await node.channel.request('fs.resolve', { path: join(remoteRoot, 'payload.txt') })
  const read = await node.channel.request('fs.readTextChunk', {
    path: resolved.canonicalPath,
    offset: 0,
    length: 4096,
  })
  assert.equal(read.text, 'from the built daemon\n')
})
