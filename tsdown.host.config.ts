/**
 * Build configuration for the host half.
 *
 * The plugin ships as one Node program that the Harness Loader mounts by
 * package name, so the shared wire contract is inlined and every Harness
 * package stays external — the profile already has exactly one copy of each,
 * and a second would break service identity.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  // `package.json` names `lib/index.js`, which is the convention a profile
  // install expects; the package is `type: module`, so `.js` is already ESM.
  outExtensions: () => ({ js: '.js' }),
  external: [/^@deepseek-ai\//],
  outputOptions: {
    banner: '// dsh-remote-worktree host half — see README.md',
  },
})
