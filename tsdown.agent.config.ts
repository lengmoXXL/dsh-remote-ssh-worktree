/**
 * Build configuration for the remote daemon.
 *
 * The daemon ships as one Node program a machine can install and run, so this
 * bundles everything it owns — including the shared wire contract — into a
 * single file. `node-pty` stays external because it is a native module that
 * must match the installing machine.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { main: 'agent/src/main.ts' },
  outDir: 'agent/lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: false,
  clean: true,
  external: ['node-pty'],
  outputOptions: {
    banner: '#!/usr/bin/env node',
  },
})
