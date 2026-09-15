/**
 * The built host half, as the Loader imports it.
 *
 * A bug this guards: bundling `node-pty` inlines its JavaScript while its
 * native binding keeps looking for prebuilds next to the file it was loaded
 * from, so the plugin failed to import with `Cannot find module
 * './prebuilds/darwin-x64/pty.node'`. Nothing else in the suite reads this
 * artifact — the composition tests load the source, and the browser test only
 * reaches it on a machine that happens to have a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

/** The host bundle, as `package.json` points at it. */
const BUNDLE = new URL('../../lib/index.js', import.meta.url)

test('the host bundle keeps the native PTY binding external', async () => {
  const source = await readFile(BUNDLE, 'utf8')

  // An external import, not a copy of node-pty's own loader.
  assert.match(source, /from "node-pty"|require\("node-pty"\)/)
  assert.equal(source.includes('prebuilds/'), false, 'node-pty was inlined')
})

test('the host bundle keeps the harness packages external', async () => {
  const source = await readFile(BUNDLE, 'utf8')

  // The profile already has exactly one copy of each; a second breaks service
  // identity, which is why these are `import`s rather than inlined code.
  assert.match(source, /from "@deepseek-ai\/cordis"/)
})
