import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeVscode, installVscodeStub, makeDocument, noCancel } from '../vscode-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');
const require = createRequire(import.meta.url);

let provider;
let restore;
let vscode;

before(async () => {
  vscode = makeVscode({}, [{ uri: { scheme: 'file', fsPath: ROOT } }]);
  restore = installVscodeStub(vscode);
  const extension = require(path.join(ROOT, 'dist', 'extension.js'));
  await extension.activate({ extensionPath: ROOT, subscriptions: [] });
  assert.equal(vscode._registered.error, undefined, 'activation reported an error');
  provider = vscode._registered.providers[0]?.provider;
  assert.ok(provider, 'no completion provider was registered');
});

after(() => restore?.());

async function complete(marked, fileDir = DATA) {
  const { document, position } = makeDocument(marked, path.join(fileDir, 'script.py'));
  return provider.provideCompletionItems(document, position, noCancel, {});
}

test('the bundled extension activates and registers on quote characters', () => {
  assert.deepEqual(vscode._registered.providers[0].triggers, ['"', "'"]);
  assert.ok(vscode._registered.commands.has('polarsense.clearCache'));
});

test('completes real column names from a real parquet file', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\nout = df.select(pl.col("|"))\n'
  );
  const labels = result.items.map((i) => i.label);
  assert.deepEqual(labels.slice(0, 4), ['region', 'revenue', 'returns_qty', 'units']);
  assert.equal(result.items.find((i) => i.label === 'revenue').detail, 'f64');
});

test('columns stay in schema order, not alphabetical', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("|")\n'
  );
  const sortTexts = result.items.map((i) => i.sortText);
  assert.deepEqual(sortTexts, [...sortTexts].sort());
  assert.equal(result.items[0].label, 'region');
});

test('the replace range covers the typed prefix but not the quotes', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("re|gion")\n'
  );
  const range = result.items[0].range;
  assert.equal(range.start.line, 2);
  assert.equal(range.start.character, 11);
  assert.equal(range.end.character, 17);
});

test('a CSV source completes from its header row', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.read_csv("sales.csv")\ndf.select("|")\n'
  );
  assert.ok(result.items.map((i) => i.label).includes('is_active'));
});

test('a delta table completes from its commit log', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_delta("delta_sales")\ndf.select("|")\n'
  );
  assert.deepEqual(
    result.items.map((i) => i.label),
    ['region', 'revenue', 'units', 'opened_at', 'price', 'tags']
  );
});

test('an iceberg table completes from its metadata pointer', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_iceberg("iceberg_sales")\ndf.select("|")\n'
  );
  assert.ok(result.items.map((i) => i.label).includes('opened_at'));
});

test('a hive-partitioned directory adds its partition column', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("hive")\ndf.select("|")\n'
  );
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('region'), 'partition column missing');
  assert.ok(labels.includes('revenue'), 'file columns missing');
});

test('an unterminated string still completes', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\nout = df.select(pl.col("re|'
  );
  assert.ok(result.items.map((i) => i.label).includes('region'));
});

test('nothing is offered where a column name does not belong', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\nprint("|")\n'
  );
  assert.equal(result, undefined);
});

test('an unidentifiable frame falls back to every schema in the file', async () => {
  const result = await complete(
    'import polars as pl\na = pl.scan_parquet("sales.parquet")\nb = pl.read_csv("sales.csv")\ne = pl.col("|")\n'
  );
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('tags'), 'parquet-only column missing from the union');
  assert.ok(result.items.every((i) => i.sortText.startsWith('1')), 'fallback items should rank below certain ones');
});

test('a missing file yields an empty list rather than an error', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("does_not_exist.parquet")\ndf.select("|")\n'
  );
  assert.deepEqual(result.items, []);
});

test('the second request for the same file is served from cache', async (t) => {
  // wide.parquet comes from `npm run fixtures`; skip rather than fail without it.
  if (!existsSync(path.join(DATA, 'wide.parquet'))) {
    return t.skip('run `npm run fixtures` to generate wide.parquet');
  }
  const snippet = 'import polars as pl\ndf = pl.scan_parquet("wide.parquet")\ndf.select("|")\n';
  await complete(snippet);
  const started = performance.now();
  const result = await complete(snippet);
  const elapsed = performance.now() - started;
  assert.equal(result.items.length, 5000);
  assert.ok(elapsed < 120, `warm completion took ${elapsed.toFixed(0)}ms`);
});
