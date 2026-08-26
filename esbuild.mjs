import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // web-tree-sitter ships ESM and calls createRequire(import.meta.url) to reach
  // node's fs. Bundled to CJS, esbuild rewrites import.meta.url to undefined and
  // the parser fails to start — so hand it a real file URL instead.
  banner: {
    js: "const __polarsense_import_meta_url = require('url').pathToFileURL(__filename).href;"
  },
  define: { 'import.meta.url': '__polarsense_import_meta_url' },
  loader: { '.wasm': 'file' }
};

/**
 * The notebook renderer is a second bundle because it runs somewhere else: an
 * output iframe, not the extension host. Browser platform, ESM, no `vscode` —
 * the only thing the two share is the pure module that decides whether an HTML
 * output looks like a frame.
 */
/** @type {import('esbuild').BuildOptions} */
const renderer = {
  entryPoints: ['src/renderer/index.ts'],
  bundle: true,
  outfile: 'dist/renderer.js',
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
};

if (watch) {
  for (const config of [options, renderer]) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
} else {
  await Promise.all([esbuild.build(options), esbuild.build(renderer)]);
}
