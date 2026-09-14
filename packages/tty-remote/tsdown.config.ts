/**
 * Build configuration for the remote terminal provider.
 *
 * The package is a library a routing provider composes, so it has no Harness
 * dependency to keep external beyond the seam it implements.
 *
 * @module dsh-tty-remote/build
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
  outputOptions: { banner: '// dsh-tty-remote' },
})
