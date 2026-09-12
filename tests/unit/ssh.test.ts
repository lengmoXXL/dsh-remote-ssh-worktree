/**
 * The command runner is the seam every install step rides, so its cases are
 * about the contract the installer depends on: a non-zero exit is a result and
 * not an exception, the command and destination reach the argument vector, and
 * a process that cannot start or outlives its deadline is the only thing that
 * rejects.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SshProcess } from '../../src/transport/ssh.ts'
import { runSsh, sshArgs, sshFailure } from '../../src/transport/ssh.ts'

/** A process stub whose exit this test controls. */
function stubProcess(exit: number, stdout = '', stderr = ''): SshProcess {
  return {
    exited: Promise.resolve(exit),
    readStdout: () => stdout,
    readStderr: () => stderr,
    send: () => {},
    kill: () => {},
  }
}

test('the shared ssh options keep the command non-interactive', () => {
  assert.deepEqual(sshArgs({ target: 'me@build-01' }), [
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ])
})

test('a destination and command reach the argument vector, and stdin closes', async () => {
  let seen: readonly string[] = []
  let sent: Buffer | string | undefined
  const result = await runSsh(
    { target: 'me@build-01', sshPort: 2222, identityFile: '~/.ssh/id_ed25519' },
    'uname -s',
    { input: 'payload' },
    {
      start: (args) => {
        seen = args
        return {
          exited: Promise.resolve(0),
          readStdout: () => 'Linux\n',
          readStderr: () => '',
          send: (input) => { sent = input },
          kill: () => {},
        }
      },
    },
  )

  assert.equal(seen.at(-1), 'uname -s')
  assert.equal(seen.at(-2), 'me@build-01')
  assert.equal(seen[seen.indexOf('-p') + 1], '2222')
  assert.equal(seen[seen.indexOf('-i') + 1], '~/.ssh/id_ed25519')
  assert.equal(sent, 'payload')
  assert.deepEqual(result, { code: 0, stdout: 'Linux\n', stderr: '' })
})

test('a non-zero exit resolves with its code and both streams', async () => {
  const result = await runSsh(
    { target: 'me@build-01' },
    'exit 3',
    {},
    { start: () => stubProcess(3, 'some output', 'some diagnostic') },
  )

  assert.deepEqual(result, { code: 3, stdout: 'some output', stderr: 'some diagnostic' })
})

test('a process that cannot start rejects naming the destination', async () => {
  await assert.rejects(
    () => runSsh(
      { target: 'me@build-01' },
      'true',
      {},
      {
        start: () => ({
          exited: Promise.reject(new Error('spawn ssh ENOENT')),
          readStdout: () => '',
          readStderr: () => '',
          send: () => {},
          kill: () => {},
        }),
      },
    ),
    /could not start ssh for "me@build-01": spawn ssh ENOENT/,
  )
})

test('a run that outlives its deadline rejects and kills the process', async () => {
  let killed = false
  await assert.rejects(
    () => runSsh(
      { target: 'me@build-01' },
      'sleep 60',
      { timeoutMs: 20 },
      {
        start: () => ({
          exited: new Promise<number>(() => {}),
          readStdout: () => '',
          readStderr: () => 'still connecting',
          send: () => {},
          kill: () => { killed = true },
        }),
      },
    ),
    /did not finish within 20ms/,
  )
  assert.equal(killed, true)
})

test('the shared diagnostic names the remedy and keeps the original text', () => {
  assert.match(sshFailure('h', 'Host key verification failed.', 'fallback'), /run `ssh h` once/)
  assert.match(sshFailure('h', 'Permission denied (publickey).', 'fallback'), /ssh-agent/)
  assert.match(sshFailure('h', 'nobody has seen this', 'could not do the thing'), /could not do the thing: nobody has seen this/)
})
