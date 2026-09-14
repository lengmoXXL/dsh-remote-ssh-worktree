/**
 * Build configuration for the local terminal provider.
 *
 * The provider is one Node module the Harness Loader mounts by package name, so
 * every Harness package stays external — the profile already has exactly one
 * copy of each, and a second would break service identity. `node-pty` carries a
 * native binding and stays external too: it is resolved from this package's own
 * `node_modules`, and inlining a `.node` binary is not a thing a bundler does.
 *
 * @module dsh-tty-local/build
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `package.json` names `lib/index.d.ts`, so the declaration must exist.
  dts: true,
  sourcemap: true,
  clean: true,
  // `package.json` names `lib/index.js`; the package is `type: module`.
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, /^node-pty$/] },
  outputOptions: { banner: '// dsh-tty-local' },
})
