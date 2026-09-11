/**
 * Cross-machine verification against a real second host.
 *
 * Everything else in this suite runs the daemon on loopback, so "remote" means
 * "another process on this machine". This script points the plugin at a daemon
 * on a different machine — reached through an SSH tunnel, which is the
 * documented deployment — and exercises every stage of the protocol against it.
 *
 * It is a script rather than a test because it needs a host and a tunnel that
 * this repository cannot provision. Run it with the tunnel open:
 *
 * ```sh
 * ssh -N -L 14780:127.0.0.1:47801 admin@<host> &
 * node scripts/verify-remote-host.ts <port> <token-file>
 * ```
 *
 * @module dsh-remote-worktree/scripts/verify-remote-host
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnchorStore } from '../src/anchors/store.ts'
import { createWorktreeManager } from '../src/worktree/manager.ts'
import { connectNode } from '../src/node/client.ts'
import type { ConnectedNode } from '../src/node/client.ts'
import type { AnchorRoute } from '../src/routing/classify.ts'
import { createRoutingSubprocessRuntime } from '../src/routing/subprocess.ts'

const [, , portArg, tokenArg] = process.argv
const port = Number(portArg ?? '14780')
const token = (await readFile(tokenArg ?? '/tmp/drw-vm149-token', 'utf8')).trim()

/** The remote paths this run uses. */
const REPO = '/home/admin/drw/repo'
const WORKTREE = `${REPO}/.dsh-worktrees/worktree/crossmach`
const FILE = '/home/admin/drw/root/cross-machine.txt'

let passed = 0
let failed = 0

/** Report one check. */
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const node: ConnectedNode = await connectNode({ host: '127.0.0.1', port, token, timeoutMs: 10_000 })
const anchors: AnchorRoute[] = [{ nodeId: 'remote', anchorPath: '/tmp/does-not-matter', remoteRoot: '/home/admin/drw/root' }]
const runtime = createRoutingSubprocessRuntime({
  localProc: new Proxy({}, {
    get: () => () => {
      throw new Error('the local delegate was reached')
    },
  }) as never,
  anchors: () => anchors,
  channel: () => node.channel,
})

console.log(`\n== handshake ==`)
console.log(`  ${node.info.platform} ${node.info.arch} · node ${node.info.node} · agent ${node.info.agentVersion}`)
console.log(`  capability: pty=${String(node.info.capability.pty)}`)
check('protocol revision is 1', node.info.protocol === 1)
check('capability reports a terminal', node.info.capability.pty === true)

console.log(`\n== fs ==`)
const CONTENT = 'written from the Mac\n'
let written
try {
  written = await node.channel.request('fs.writeText', {
    path: FILE,
    content: CONTENT,
    expected: { kind: 'createIfAbsent' },
  })
  check('a file is created on the other machine', written.operation === 'create', written.version)
} catch {
  // A previous run left the file: observe it, then replace under the guard,
  // which is the other half of the same contract.
  const existing = await node.channel.request('fs.stat', { path: FILE })
  written = await node.channel.request('fs.writeText', {
    path: FILE,
    content: CONTENT,
    expected: { kind: 'replaceIfVersion', version: existing!.version },
  })
  check('an existing file is replaced under the version guard', written.operation === 'update', written.version)
}
const read = await node.channel.request('fs.readTextChunk', { path: FILE, offset: 0, length: 4096 })
check('it reads back byte-identically', read.text === CONTENT)
const stat = await node.channel.request('fs.stat', { path: FILE })
check('stat reports a regular file', stat?.type === 'file')

console.log(`\n== subprocess ==`)
const uname = runtime.spawn({
  argv: ['bash', '-c', 'uname -srm; echo "user=$(id -un)"; echo "cwd=$(pwd)"'],
  cwd: '/home/admin/drw/root',
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 } },
  graceMs: 3000,
})
await uname.done
const unameText = uname.collected.stdout?.readFrom(0).text ?? ''
console.log(`  ${unameText.trim().split('\n').join('\n  ')}`)
check('the command ran on Linux, not on this Mac', /Linux/.test(unameText))
check('it ran as the remote user', /user=admin/.test(unameText))
check('in the remote working directory', /cwd=\/home\/admin\/drw\/root/.test(unameText))

console.log(`\n== piped stdout (live) ==`)
const piped = runtime.spawn({
  argv: ['bash', '-c', 'printf first; sleep 1; printf second'],
  cwd: '/home/admin/drw/root',
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1 << 16 } },
  graceMs: 3000,
})
const pipedText: string[] = []
piped.stdout?.on('data', (chunk: Buffer | string) => pipedText.push(chunk.toString()))
let pipedExited = false
void piped.done.then(() => { pipedExited = true })
const pipedDeadline = Date.now() + 800
while (!pipedText.join('').includes('first') && Date.now() < pipedDeadline) {
  await new Promise(resolve => setTimeout(resolve, 25))
}
check('the first chunk crossed the network while the child still ran', pipedText.join('').includes('first') && !pipedExited)
await piped.done
check('the stream completed', pipedText.join('') === 'firstsecond')

console.log(`\n== git worktree (through the plugin lifecycle) ==`)
const anchorRoot = await mkdtemp(join(tmpdir(), 'drw-crossmach-anchors-'))
const anchors2 = createAnchorStore({ root: anchorRoot })
await anchors2.load()
const worktrees = createWorktreeManager({ anchors: anchors2, channel: () => node.channel })
try {
  // Through the manager, not the raw git method: the local anchor and the
  // gitignore that keeps the repository clean are the manager's job.
  const anchor = await worktrees.create({ nodeId: 'remote', repoPath: REPO, name: 'crossmach' })
  check('a worktree is cut on the other machine', anchor.remoteRoot === WORKTREE, anchor.branch)
  check('a local anchor names it', anchor.anchorPath.startsWith(anchorRoot))
  const state = await node.channel.request('git.repoState', { repoPath: REPO })
  check('the repository tolerates the managed directory', state.clean)

  const statuses = await worktrees.list()
  check('the manager lists it with live state', statuses.length === 1 && statuses[0]?.repo?.clean === true)

  const removal = await worktrees.remove(anchor.anchorId, { force: true, deleteBranch: true })
  check('it is removed again', removal.branchDeleted)
} catch (error) {
  check('git worktree round trip', false, error instanceof Error ? error.message : String(error))
} finally {
  await rm(anchorRoot, { recursive: true, force: true })
}

console.log(`\n== terminal (PTY on the other machine) ==`)
try {
  const terminal = await runtime.spawnTerminal({
    argv: ['/bin/bash', '-i'],
    cwd: '/home/admin/drw/root',
    rows: 24,
    cols: 80,
    graceMs: 1000,
  })
  const terminalText: string[] = []
  terminal.output.on('data', (chunk: Buffer | string) => terminalText.push(chunk.toString()))
  const terminalDeadline = Date.now() + 8000
  while (!terminalText.join('').includes('cross-machine-pty') && Date.now() < terminalDeadline) {
    await terminal.write('echo cross-machine-pty\n')
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  check('a PTY is allocated and answers on the other machine', terminalText.join('').includes('cross-machine-pty'))
  await terminal.terminate()
  await terminal.done
} catch (error) {
  check('terminal round trip', false, error instanceof Error ? error.message : String(error))
}

node.close()
console.log(`\n== ${String(passed)} passed, ${String(failed)} failed ==\n`)
process.exit(failed === 0 ? 0 : 1)
