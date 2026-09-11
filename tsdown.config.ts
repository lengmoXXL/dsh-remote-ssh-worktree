/**
 * Build configuration for the browser half.
 *
 * The web shell loads a plugin's client bundle through a module loader it
 * installs on `window`, so the artifact must be one CommonJS factory call
 * rather than an ES module: `react` and every `@deepseek-ai/*` package are
 * resolved through the `require` the loader hands the factory, and everything
 * else is inlined.
 *
 * A dynamic bundle has no stylesheet channel, so `*.module.css` is compiled
 * here instead of being emitted as a file: Lightning CSS hashes every local
 * name, and the plugin emits a module that attaches one tagged `<style>` to
 * the document the first time the factory runs and hands the component the
 * class map. That keeps the component on the same CSS Modules contract the
 * in-repo client packages use — local names, semantic `--dsw-*` tokens, no
 * global leakage — and `clsx` is inlined because it is a browser-only
 * implementation library with no module-table identity to share.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The plugin id the loader keys this bundle by; it must match `dsh.client`. */
const ID = 'dsh-remote-worktree'

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0drw-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the compiled class map. */
function styleInjectionModule(
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  const tagId = `${ID}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Compile every `*.module.css` import into an injecting module. */
function cssModulesInline() {
  return {
    name: 'drw-css-modules-inline',
    resolveId(source: string, importer: string | undefined): string | null {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string): Promise<string | null> {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // A virtual id otherwise hides the physical stylesheet from the watcher.
      this.addWatchFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) {
        classMap[local] = exported.name
      }
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

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
  plugins: [cssModulesInline()],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
})
