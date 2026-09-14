/**
 * Build configuration for the terminal seam.
 *
 * The package is one Node module the providers and their consumers share, and
 * every Harness package stays external: the profile already holds exactly one
 * copy of each, and a second would break service identity.
 *
 * @module dsh-tty/build
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
  deps: { neverBundle: [/^@deepseek-ai\//] },
  outputOptions: { banner: '// dsh-tty' },
})
