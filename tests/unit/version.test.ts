/**
 * The plugin installs the agent release whose version it names, so the two
 * must never drift: a plugin that expected a build the release does not carry
 * would fail on every machine at once. This reads the crate manifest directly
 * rather than trusting a build step to have copied the number.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { AGENT_VERSION } from '../../src/agent/version.ts'

test('the crate version matches the agent build the plugin installs', async () => {
  const manifest = await readFile(new URL('../../agent/Cargo.toml', import.meta.url), 'utf8')
  const match = /^version = "(.+)"$/m.exec(manifest)
  assert.notEqual(match, null)
  assert.equal(match?.[1], AGENT_VERSION)
})
