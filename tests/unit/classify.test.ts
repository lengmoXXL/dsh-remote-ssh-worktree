/**
 * Route classification is the one piece of this plugin where a wrong answer is
 * silent: a mis-routed path reads one machine and writes another. These cases
 * pin the precedence rules and the two traps they exist for — the shared remote
 * root, and the sibling directory whose name merely starts with an anchor's.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { classifyPath, isWithin, toAbsolute } from '../../src/plugin/routing/classify.ts'
import { asNodeId } from '../../src/ids.ts'

const anchorA: AnchorRoute = {
  nodeId: asNodeId('a'),
  anchorPath: '/Users/dev/.dsh/remote-worktrees/a/proj/main',
  remoteRoot: '/home/dev/proj',
}

const anchorB: AnchorRoute = {
  nodeId: asNodeId('b'),
  anchorPath: '/Users/dev/.dsh/remote-worktrees/b/proj/main',
  remoteRoot: '/home/dev/proj',
}

test('isWithin matches whole segments only', () => {
  assert.equal(isWithin('/srv/app', '/srv/app'), true)
  assert.equal(isWithin('/srv/app', '/srv/app/x'), true)
  assert.equal(isWithin('/srv/app', '/srv/app-old'), false)
  assert.equal(isWithin('/srv/app', '/srv'), false)
})

test('toAbsolute resolves against the base and normalizes', () => {
  assert.equal(toAbsolute('../x', '/a/b'), '/a/x')
  assert.equal(toAbsolute('/a/./b/../c', undefined), '/a/c')
  assert.equal(toAbsolute('rel', undefined), '/rel')
})

test('a path outside every anchor stays local', () => {
  assert.deepEqual(classifyPath('/etc/hosts', undefined, [anchorA]), { kind: 'local' })
})

test('an anchor path routes to its node and maps onto the remote root', () => {
  const route = classifyPath(`${anchorA.anchorPath}/src/index.ts`, undefined, [anchorA])
  assert.deepEqual(route, {
    kind: 'remote',
    nodeId: asNodeId('a'),
    remotePath: '/home/dev/proj/src/index.ts',
  })
})

test('a relative path resolves against an anchor cwd', () => {
  const route = classifyPath('src/index.ts', anchorA.anchorPath, [anchorA])
  assert.deepEqual(route, {
    kind: 'remote',
    nodeId: asNodeId('a'),
    remotePath: '/home/dev/proj/src/index.ts',
  })
})

test('the anchor itself maps to the remote root', () => {
  const route = classifyPath(anchorA.anchorPath, undefined, [anchorA])
  assert.deepEqual(route, { kind: 'remote', nodeId: asNodeId('a'), remotePath: '/home/dev/proj' })
})

test('a remote root claimed by exactly one anchor routes there', () => {
  const route = classifyPath('/home/dev/proj/README.md', undefined, [anchorA])
  assert.deepEqual(route, {
    kind: 'remote',
    nodeId: asNodeId('a'),
    remotePath: '/home/dev/proj/README.md',
  })
})

test('a remote root claimed by two anchors is refused, not guessed', () => {
  const route = classifyPath('/home/dev/proj/README.md', undefined, [anchorA, anchorB])
  assert.deepEqual(route, {
    kind: 'ambiguous',
    remotePath: '/home/dev/proj/README.md',
    nodeIds: ['a', 'b'],
  })
})

test('the explicit spelling outranks anchor matching', () => {
  const route = classifyPath('node:b:/home/dev/proj/x.ts', undefined, [anchorA, anchorB])
  assert.deepEqual(route, { kind: 'remote', nodeId: asNodeId('b'), remotePath: '/home/dev/proj/x.ts' })
})

test('a sibling directory sharing a name prefix does not match a remote root', () => {
  const route = classifyPath('/home/dev/proj-old/x.ts', undefined, [anchorA])
  assert.deepEqual(route, { kind: 'local' })
})
