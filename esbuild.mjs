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

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
