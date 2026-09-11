/**
 * A workspace title is read by a person scanning a list, so its contract is
 * that it names the three distinguishing facts — machine, repository, checkout
 * — and never an opaque id. These cases pin the fallbacks that keep a title
 * readable when a record is missing or a path has no last segment.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { worktreeLabel } from '../src/worktree/label.ts'

test('a title names machine, repository, and checkout in that order', () => {
  assert.equal(
    worktreeLabel({ machine: 'vm149', repoPath: '/workspace/ACM-notes', name: 'web-verify' }),
    'vm149 · ACM-notes · web-verify',
  )
})

test('a path with no segment is not blank', () => {
  assert.equal(worktreeLabel({ machine: 'box', repoPath: '/', name: 'x' }), 'box · / · x')
  assert.equal(worktreeLabel({ machine: 'box', repoPath: '', name: 'x' }), 'box ·  · x')
})

test('a trailing separator does not produce an empty segment', () => {
  assert.equal(
    worktreeLabel({ machine: 'box', repoPath: '/srv/app/', name: 'x' }),
    'box · app · x',
  )
})

test('a registered repository name wins over the derived one', () => {
  assert.equal(
    worktreeLabel({ machine: 'box', repoPath: '/srv/app', repoName: 'api', name: 'x' }),
    'box · api · x',
  )
})

test('a blank registered name falls back to the path segment', () => {
  assert.equal(
    worktreeLabel({ machine: 'box', repoPath: '/srv/app', repoName: '   ', name: 'x' }),
    'box · app · x',
  )
})

test('no title part is an id the caller did not ask for', () => {
  const title = worktreeLabel({
    machine: '378d3d80-6fc7-45a7-9893-4174cb582d06',
    repoPath: '/srv/app',
    name: 'x',
  })
  // The machine segment is whatever the caller passed; this pins only that the
  // builder adds nothing of its own.
  assert.equal(title, '378d3d80-6fc7-45a7-9893-4174cb582d06 · app · x')
})
