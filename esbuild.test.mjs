import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/harness.ts'],
  bundle: true,
  outfile: 'test/harness.mjs',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['hyparquet', 'web-tree-sitter', 'vscode'],
  logLevel: 'warning'
});
