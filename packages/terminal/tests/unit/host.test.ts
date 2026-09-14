/**
 * The host half's two decisions, away from a socket: which directory a Session
 * opens in, and whether a terminal can be resized.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { resizeTerminal } from '../../src/host/resize.ts'
import { resolveWorkspace, TerminalFailure } from '../../src/host/workspace.ts'

/** A context carrying only what the workspace resolver reads. */
function hostContext(options: {
  live?: { cwd?: string } | undefined
  stored?: { header?: { cwd?: string } } | undefined
}): Context {
  return {
    sessions: {
      get: () => options.live === undefined ? undefined : { header: options.live },
    },
    get: (name: string) => name === 'sessionPersistence' && options.stored !== undefined
      ? { stat: () => Promise.resolve(options.stored) }
      : undefined,
  } as unknown as Context
}

test('a live Session answers with its own workspace', async () => {
  const ctx = hostContext({ live: { cwd: '/w/live' } })
  assert.equal(await resolveWorkspace(ctx, 'session-1'), '/w/live')
})

test('a Session the host is not running answers from its stored header', async () => {
  const ctx = hostContext({ stored: { header: { cwd: '/w/stored' } } })
  assert.equal(await resolveWorkspace(ctx, 'session-1'), '/w/stored')
})

test('an unknown Session is a typed refusal, not a fallback directory', async () => {
  const ctx = hostContext({})
  await assert.rejects(resolveWorkspace(ctx, 'session-1'), (error: unknown) => {
    assert.ok(error instanceof TerminalFailure)
    assert.equal(error.code, 'terminal/unknown-session')
    return true
  })
})

test('an empty Session identity is refused before anything is read', async () => {
  const ctx = hostContext({ live: { cwd: '/w/live' } })
  await assert.rejects(resolveWorkspace(ctx, '  '), TerminalFailure)
})

test('a provider that publishes resize is used', async () => {
  const calls: number[][] = []
  const handle = {
    resize: (cols: number, rows: number) => {
      calls.push([cols, rows])
    },
  } as unknown as SubprocessTerminalHandle
  assert.equal(await resizeTerminal(handle, 120, 40), true)
  assert.deepEqual(calls, [[120, 40]])
})

test('a local provider is resized through the node-pty process it keeps', async () => {
  const calls: number[][] = []
  const handle = {
    terminal: {
      resize: (cols: number, rows: number) => {
        calls.push([cols, rows])
      },
    },
  } as unknown as SubprocessTerminalHandle
  assert.equal(await resizeTerminal(handle, 60, 20), true)
  assert.deepEqual(calls, [[60, 20]])
})

test('a terminal with no resize capability reports the fact instead of failing', async () => {
  const handle = {} as unknown as SubprocessTerminalHandle
  assert.equal(await resizeTerminal(handle, 80, 24), false)
})
