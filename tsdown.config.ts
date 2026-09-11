/**
 * Build configuration for the browser half.
 *
 * The web shell loads a plugin's client bundle through a module loader it
 * installs on `window`, so the artifact must be one CommonJS factory call
 * rather than an ES module: `react` and every `@deepseek-ai/*` package are
 * resolved through the `require` the loader hands the factory, and everything
 * else is inlined.
 */

import { defineConfig } from 'tsdown'

/** The plugin id the loader keys this bundle by; it must match `dsh.client`. */
const ID = 'dsh-remote-worktree'

export default defineConfig({
  entry: { client: 'client/client.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  // React and the client stack are the shell's, not ours: a second copy would
  // break hooks and duplicate the renderer.
  external: [/^react($|\/)/, /^@deepseek-ai\//],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
})
