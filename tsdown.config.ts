/**
 * tsdown build for dsh-motion-pet — single-package adaptation of the DSH
 * client bundle preset (deepseek-harness `packages/client/tsdown.client.ts`,
 * verified against dsh 0.1.0-rc.7; see docs/implementation-notes.md §5).
 *
 * Three artifacts:
 * - lib/index.js   host half (ESM, node; @deepseek-ai/* stay external and
 *                  resolve from the dsh profile tree at runtime)
 * - lib/client.js  browser half (CJS factory wrapped in the
 *                  `window.__ModuleLoader__.load({id, factory})` handoff the
 *                  shell expects; externals limited to the shell module table)
 * - preview/preview.js  standalone dev preview (fully self-contained IIFE —
 *                  no shell, react inlined; open preview/index.html via any
 *                  static server or file://)
 * - lib/editor.js   the standalone full-page settings editor the host serves
 *                  at /motion-pet-editor/ (same self-contained IIFE pattern
 *                  as the preview)
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The module specifiers the shell shares into the frozen module table (rc.7). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Externals resolved from the loader module table: the platform seed entries
 * plus the documented runtime-store exemption (defineStore lives in
 * dsh-client-runtime pending upstream rehoming).
 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

/** Browser bundles inline node-idiom deps; without these the factory throws at boot. */
const ENV_DEFINES: Record<string, string> = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * CSS Modules inside the bundle: importing `x.module.css` yields the hashed
 * class map (lightningcss `[hash]_[local]`), and the css text injects one
 * `<style data-plugin-css>` tag at factory execution. tsdown's own css
 * pipeline is sidestepped with a virtual id that does not end in `.css`.
 */
function cssModulesInline(pluginId: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const physical = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(physical)
      const source = await readFile(physical)
      const { code, exports: cssExports } = transform({
        filename: basename(physical),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        classMap[local] = exp.name
      }
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${pluginId}/${basename(physical)}`)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/**
 * Bundle purity gate: client code may only value-import the shell's platform
 * modules; every other @deepseek-ai/* value import either inlines a duplicate
 * runtime instance or requires a specifier the frozen module table cannot
 * answer. Cross-plugin collaboration goes through cordis services; type-only
 * imports are erased and never reach this gate.
 */
function clientBundlePurity() {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the shell module table — ` +
          'value-importing it would duplicate runtime identity. Use cordis services or type-only imports.',
      )
    },
  }
}

const lib: UserConfig = {
  name: 'dsh-motion-pet',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The cordis framework and official API packages resolve at runtime from
  // the dsh profile tree, never bundled.
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
}

const client: UserConfig = {
  name: 'dsh-motion-pet/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  // clean must stay off — it would wipe the node-half output emitted above.
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    // Anything NOT in the loader module table must inline instead — a
    // require() the table cannot answer is a guaranteed runtime throw.
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  },
  define: ENV_DEFINES,
  plugins: [clientBundlePurity(), cssModulesInline('dsh-motion-pet')],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "dsh-motion-pet", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const preview: UserConfig = {
  name: 'dsh-motion-pet/preview',
  entry: { preview: 'src/preview/index.tsx' },
  outDir: 'preview',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Fully self-contained: no externals, no module table.
    alwaysBundle: [/.*/],
    onlyBundle: false, // react et al. are inlined on purpose; silence the hint
  },
  define: ENV_DEFINES,
  plugins: [cssModulesInline('dsh-motion-pet/preview')],
  outputOptions: {
    entryFileNames: 'preview.js',
  },
}

const editor: UserConfig = {
  name: 'dsh-motion-pet/editor',
  entry: { editor: 'src/editor/index.tsx' },
  outDir: 'lib',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Fully self-contained like the preview: the host serves this bundle
    // directly, there is no shell module table on the editor page.
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
  define: ENV_DEFINES,
  plugins: [clientBundlePurity(), cssModulesInline('dsh-motion-pet/editor')],
  outputOptions: {
    entryFileNames: 'editor.js',
  },
}

export default [lib, client, preview, editor]
