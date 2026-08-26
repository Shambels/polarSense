import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  makeVscode, installVscodeStub, makeDocument, makeNotebook, noCancel, setSetting,
  unregisterSetting
} from '../vscode-stub.mjs';
import { looksLikeFrame, lastStatementOffset } from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');
const require = createRequire(import.meta.url);

let provider;
let restore;
let vscode;
let api;

before(async () => {
  vscode = makeVscode({}, [{ uri: { scheme: 'file', fsPath: ROOT } }]);
  restore = installVscodeStub(vscode);
  const extension = require(path.join(ROOT, 'dist', 'extension.js'));
  api = await extension.activate({ extensionPath: ROOT, subscriptions: [] });
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

test('completes from an arrow file, end to end through the schema service', async () => {
  // The reader is unit-tested against the fixture; this is the wiring — that an
  // `ipc` source reaches it at all, and that a dtype comes back with the name.
  const result = await complete(
    'import polars as pl\ndf = pl.scan_ipc("sales.arrow")\nout = df.select(pl.col("|"))\n'
  );
  const labels = result.items.map((i) => i.label);
  assert.deepEqual(labels.slice(0, 4), ['region', 'revenue', 'returns_qty', 'units']);
  assert.equal(result.items.find((i) => i.label === 'tags').detail, 'list[str]');
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

test('data paths become ctrl-clickable links to the real file', async () => {
  const provider = vscode._registered.linkProviders[0]?.provider;
  assert.ok(provider, 'no document link provider was registered');

  const { document } = makeDocument(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ncsv = pl.read_csv("sales.csv")\n',
    path.join(DATA, 'script.py')
  );
  const links = await provider.provideDocumentLinks(document, noCancel);

  assert.equal(links.length, 2);
  assert.equal(links[0].target.fsPath, path.join(DATA, 'sales.parquet'));
  assert.equal(links[1].target.fsPath, path.join(DATA, 'sales.csv'));
  // The link covers the path text, not the whole call.
  const text = document.getText();
  assert.equal(
    text.slice(document.offsetAt(links[0].range.start), document.offsetAt(links[0].range.end)),
    'sales.parquet'
  );
});

test('a path that resolves to nothing produces no link', async () => {
  const provider = vscode._registered.linkProviders[0].provider;
  const { document } = makeDocument(
    'import polars as pl\ndf = pl.scan_parquet("missing.parquet")\n',
    path.join(DATA, 'script.py')
  );
  assert.deepEqual(await provider.provideDocumentLinks(document, noCancel), []);
});

test('a directory link points at the concrete file it resolves to', async () => {
  const provider = vscode._registered.linkProviders[0].provider;
  const { document } = makeDocument(
    'import polars as pl\ndf = pl.scan_parquet("hive")\n',
    path.join(DATA, 'script.py')
  );
  const links = await provider.provideDocumentLinks(document, noCancel);
  assert.equal(links.length, 1);
  assert.ok(links[0].target.fsPath.endsWith('.parquet'), 'should point at a file, not the folder');
  assert.ok(links[0].tooltip?.startsWith('Open '), 'tooltip should name the resolved file');
});

async function hover(marked, fileDir = DATA) {
  const p = vscode._registered.hoverProviders[0]?.provider;
  assert.ok(p, 'no hover provider was registered');
  const { document, position } = makeDocument(marked, path.join(fileDir, 'script.py'));
  return p.provideHover(document, position, noCancel);
}

test('hovering a column shows its dtype and the file it came from', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("reg|ion")\n'
  );
  assert.ok(result, 'no hover returned');
  assert.match(result.contents.value, /\*\*region\*\*/);
  assert.match(result.contents.value, /`str`/);
  assert.match(result.contents.value, /sales\.parquet · 3 rows/);
});

test('hover carries the statistics out of the parquet footer', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("reve|nue")\n'
  );
  assert.match(result.contents.value, /min `1\.5`/);
  assert.match(result.contents.value, /max `3`/);
  assert.match(result.contents.value, /no nulls/);
});

test('hover reports a null count when there is one', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("not|es")\n'
  );
  assert.match(result.contents.value, /1 nulls/);
});

test('hover formats a date statistic as a date', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("order|_date")\n'
  );
  assert.match(result.contents.value, /min `2026-01-01`/);
});

test('hovering the path shows the resolved file and its shape', async () => {
  const result = await hover('import polars as pl\ndf = pl.scan_parquet("sale|s.parquet")\n');
  assert.ok(result, 'no hover returned for the path');
  assert.match(result.contents.value, /sales\.parquet/);
  assert.match(result.contents.value, /9 columns · 3 rows/);
});

test('hovering a name that is not a column gives nothing', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("nope|")\n'
  );
  assert.equal(result, undefined);
});

test('a csv column hovers without inventing statistics', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.read_csv("sales.csv")\ndf.select("reg|ion")\n'
  );
  assert.match(result.contents.value, /\*\*region\*\*/);
  assert.doesNotMatch(result.contents.value, /min |max |nulls/);
});

// --- schema propagation: the columns that exist here, not everything in the file ---
async function labels(marked, fileDir = DATA) {
  const result = await complete(marked, fileDir);
  return result?.items.map((i) => i.label);
}
const HEAD_PY = 'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\n';

test('select narrows what is offered downstream', async () => {
  const got = await labels(`${HEAD_PY}narrow = df.select("region", "revenue")\nnarrow.select("|")\n`);
  assert.deepEqual(got, ['region', 'revenue']);
});

test('rename offers the new name and not the old one', async () => {
  const got = await labels(`${HEAD_PY}r = df.rename({"region": "zone"})\nr.select("|")\n`);
  assert.ok(got.includes('zone'), 'renamed column missing');
  assert.ok(!got.includes('region'), 'old name should be gone');
});

test('drop removes a column from the offer', async () => {
  const got = await labels(`${HEAD_PY}d = df.drop("notes", "tags")\nd.select("|")\n`);
  assert.ok(!got.includes('notes'));
  assert.ok(!got.includes('tags'));
  assert.ok(got.includes('region'));
});

test('with_columns adds the alias it creates', async () => {
  const got = await labels(
    `${HEAD_PY}w = df.with_columns(pl.col("revenue").sum().alias("total"))\nw.select("|")\n`
  );
  assert.ok(got.includes('total'), 'alias missing');
  assert.ok(got.includes('region'), 'existing columns should survive');
});

test('a keyword argument names its own column', async () => {
  const got = await labels(`${HEAD_PY}w = df.with_columns(uplift=pl.col("revenue") * 2)\nw.select("|")\n`);
  assert.ok(got.includes('uplift'));
});

test('with_row_index puts its column first', async () => {
  const got = await labels(`${HEAD_PY}w = df.with_row_index("idx")\nw.select("|")\n`);
  assert.equal(got[0], 'idx');
});

test('group_by then agg offers keys and aggregates only', async () => {
  const got = await labels(
    `${HEAD_PY}g = df.group_by("region").agg(pl.col("revenue").sum())\ng.select("|")\n`
  );
  assert.deepEqual(got, ['region', 'revenue']);
});

test('inside agg the full input frame is still offered', async () => {
  const got = await labels(`${HEAD_PY}df.group_by("region").agg(pl.col("|"))\n`);
  assert.ok(got.includes('units'), 'agg should see every input column');
});

test('transformations chain', async () => {
  const got = await labels(
    `${HEAD_PY}out = df.select("region", "revenue").rename({"revenue": "rev"}).drop("region")\nout.select("|")\n`
  );
  assert.deepEqual(got, ['rev']);
});

test('a filter in the chain changes nothing', async () => {
  const got = await labels(
    `${HEAD_PY}out = df.select("region").filter(pl.col("region") == "EU").sort("region")\nout.select("|")\n`
  );
  assert.deepEqual(got, ['region']);
});

test('a join offers both frames, suffixing the collisions', async () => {
  const got = await labels(
    'import polars as pl\n' +
    'a = pl.scan_parquet("sales.parquet").select("region", "revenue")\n' +
    'b = pl.read_csv("sales.csv").select("region", "units")\n' +
    'j = a.join(b, on="region")\nj.select("|")\n'
  );
  assert.deepEqual(got, ['region', 'revenue', 'units']);
});

test('a join on different keys keeps both key columns', async () => {
  const got = await labels(
    'import polars as pl\n' +
    'a = pl.scan_parquet("sales.parquet").select("region", "revenue")\n' +
    'b = pl.read_csv("sales.csv").select("region", "units")\n' +
    'j = a.join(b, left_on="region", right_on="region")\nj.select("|")\n'
  );
  assert.ok(got.includes('region'));
  assert.ok(got.includes('region_right'), 'the right key should be suffixed, not dropped');
});

test('a semi join offers only the left frame', async () => {
  const got = await labels(
    'import polars as pl\n' +
    'a = pl.scan_parquet("sales.parquet").select("region")\n' +
    'b = pl.read_csv("sales.csv").select("units")\n' +
    'j = a.join(b, on="region", how="semi")\nj.select("|")\n'
  );
  assert.deepEqual(got, ['region']);
});

test('pl.all() means every column of the input', async () => {
  const got = await labels(`${HEAD_PY}w = df.select(pl.all())\nw.select("|")\n`);
  assert.ok(got.includes('region') && got.includes('tags'));
});

test('pl.exclude() removes from the whole set', async () => {
  const got = await labels(`${HEAD_PY}w = df.select(pl.exclude("notes"))\nw.select("|")\n`);
  assert.ok(!got.includes('notes'));
  assert.ok(got.includes('region'));
});

test('an unmodelled reshape keeps the columns but marks them uncertain', async () => {
  const result = await complete(`${HEAD_PY}p = df.pivot(on="region")\np.select("|")\n`);
  assert.ok(result.items.length > 0, 'should still offer something useful');
  assert.ok(
    result.items.every((i) => i.sortText.startsWith('1')),
    'an unmodelled step should rank its guesses below certain answers'
  );
});

test('a selector we cannot read statically does not narrow wrongly', async () => {
  const result = await complete(`${HEAD_PY}w = df.select(cs.numeric())\nw.select("|")\n`);
  const got = result.items.map((i) => i.label);
  assert.ok(got.includes('region'), 'must not invent a narrowed list');
  assert.ok(result.items.every((i) => i.sortText.startsWith('1')), 'and must admit uncertainty');
});

test('dtypes survive propagation', async () => {
  const result = await complete(`${HEAD_PY}n = df.select("revenue")\nn.select("|")\n`);
  assert.equal(result.items[0].detail, 'f64');
});

// --- diagnostics: only speak when sure ---
async function diagnose(marked, fileDir = DATA) {
  const collection = vscode._registered.diagnostics;
  assert.ok(collection, 'no diagnostic collection was created');
  const { document } = makeDocument(marked, path.join(fileDir, 'script.py'));
  // Reach the provider through the same object activation registered.
  const provider = vscode._registered.codeActionProviders[0]?.provider;
  assert.ok(provider, 'no code action provider was registered');
  await provider.diagnostics.refresh(document);
  return { document, items: collection.get(document.uri), provider };
}

test('a misspelled column is flagged, with the right name suggested', async () => {
  const { items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("regoin")\n'
  );
  assert.equal(items.length, 1);
  assert.match(items[0].message, /No column "regoin"/);
  assert.match(items[0].message, /Did you mean "region"/);
  assert.equal(items[0].severity, 1, 'should be a warning, not an error');
});

test('a correct column is not flagged', async () => {
  const { items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("region", "revenue")\n'
  );
  assert.deepEqual(items, []);
});

test('the flag lands on the column text, not the whole call', async () => {
  const { document, items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("regoin")\n'
  );
  const text = document.getText();
  const start = document.offsetAt(items[0].range.start);
  const end = document.offsetAt(items[0].range.end);
  assert.equal(text.slice(start, end), 'regoin');
});

test('a column dropped upstream is flagged downstream', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'n = df.select("region", "revenue")\n' +
    'n.sort("units")\n'
  );
  assert.equal(items.length, 1);
  assert.match(items[0].message, /No column "units"/);
});

test('a column created upstream is not flagged', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'w = df.with_columns(pl.col("revenue").sum().alias("total"))\n' +
    'w.select("total")\n'
  );
  assert.deepEqual(items, []);
});

test('a renamed column is flagged under its old name', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'r = df.rename({"region": "zone"})\n' +
    'r.select("region")\n'
  );
  assert.equal(items.length, 1);
  assert.match(items[0].message, /No column "region"/);
});

/** Everything below must stay silent — these are the false positives that would kill it. */
test('silent: an unmodelled reshape', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'p = df.pivot(on="region")\n' +
    'p.select("anything_at_all")\n'
  );
  assert.deepEqual(items, [], 'must not accuse after a step it cannot model');
});

test('silent: a selector it cannot read', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'w = df.select(cs.numeric())\n' +
    'w.select("region")\n'
  );
  assert.deepEqual(items, []);
});

test('silent: a frame it cannot identify', async () => {
  const { items } = await diagnose(
    'import polars as pl\ndef f(df):\n    return df.select("nonsense")\n'
  );
  assert.deepEqual(items, []);
});

test('silent: a file it cannot read', async () => {
  const { items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("missing.parquet")\ndf.select("nonsense")\n'
  );
  assert.deepEqual(items, []);
});

test('silent: the path argument is not a column', async () => {
  const { items } = await diagnose('import polars as pl\ndf = pl.scan_parquet("sales.parquet")\n');
  assert.deepEqual(items, []);
});

test('silent: strings that are not column sites', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'print("hello")\n' +
    'x = "just a string"\n' +
    'df.rename({"region": "a brand new name"})\n'
  );
  assert.deepEqual(items, []);
});

test('the quick fix replaces the typo with the suggestion', async () => {
  const { document, items, provider } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("regoin")\n'
  );
  const actions = provider.provideCodeActions(document, items[0].range, { diagnostics: items });
  assert.ok(actions.length >= 1, 'no quick fix offered');
  assert.equal(actions[0].title, 'Change to "region"');
  assert.equal(actions[0].edit.edits[0].newText, 'region');
  assert.equal(actions[0].isPreferred, true);
});

test('diagnostics can be turned off', async () => {
  vscode._settings['diagnostics.enable'] = false;
  try {
    const { items } = await diagnose(
      'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("regoin")\n'
    );
    assert.deepEqual(items, []);
  } finally {
    vscode._settings['diagnostics.enable'] = true;
  }
  // And back on again.
  const { items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.select("regoin")\n'
  );
  assert.equal(items.length, 1);
});

// --- hover: the two gaps the probe found ---
test('hover names the file by path, not just its basename', async () => {
  // hive/region=EU/part-0.parquet and hive/region=US/part-0.parquet share a
  // basename, so a basename alone cannot say which one you are looking at.
  const result = await hover(
    'import polars as pl\nh = pl.scan_parquet("hive")\nh.select("reve|nue")\n'
  );
  assert.match(result.contents.value, /hive\/region=/);
  assert.doesNotMatch(result.contents.value, /_part-0\.parquet ·/);
});

test('hover falls back like the completion list does', async () => {
  // Completion offers the union of every schema in the file when it cannot
  // identify the frame; hover used to give nothing for the very name it offered.
  const result = await hover(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'def f(d):\n' +
    '    return d.select("reg|ion")\n'
  );
  assert.ok(result, 'hover gave nothing where completion would have offered the name');
  assert.match(result.contents.value, /\*\*region\*\*/);
  assert.match(result.contents.value, /`str`/);
  assert.match(result.contents.value, /could not be identified/, 'must admit it is a guess');
});

test('the hover fallback respects the setting that governs the completion one', async () => {
  vscode._settings.fallbackToAllSchemas = false;
  try {
    const result = await hover(
      'import polars as pl\n' +
      'df = pl.scan_parquet("sales.parquet")\n' +
      'def f(d):\n' +
      '    return d.select("reg|ion")\n'
    );
    assert.equal(result, undefined);
  } finally {
    vscode._settings.fallbackToAllSchemas = true;
  }
});

test('hover still says nothing where a column name does not belong', async () => {
  assert.equal(await hover('import polars as pl\nprint("hel|lo")\n'), undefined);
  assert.equal(
    await hover('import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.rename({"region": "new|name"})\n'),
    undefined
  );
});

test('a name that is nowhere in the file hovers to nothing', async () => {
  const result = await hover(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'def f(d):\n' +
    '    return d.select("not_a_col|umn")\n'
  );
  assert.equal(result, undefined);
});

// --- df["…"] and get_column ---
test('a subscript offers the frame\'s columns', async () => {
  const got = await labels(`${HEAD_PY}df["|"]\n`);
  assert.deepEqual(got.slice(0, 3), ['region', 'revenue', 'returns_qty']);
});

test('get_column offers them too', async () => {
  const got = await labels(`${HEAD_PY}df.get_column("|")\n`);
  assert.ok(got.includes('region'));
});

test('a subscript respects what the chain narrowed to', async () => {
  const got = await labels(`${HEAD_PY}n = df.select("region", "revenue")\nn["|"]\n`);
  assert.deepEqual(got, ['region', 'revenue']);
});

test('a dict subscript offers nothing, not even the fallback', async () => {
  // The all-schemas fallback would otherwise put column names inside every
  // dictionary lookup in a file that happens to use polars.
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ncfg = {"path": "x"}\ncfg["|"]\n'
  );
  assert.equal(result, undefined);
});

test('a subscript on an unknown name offers nothing', async () => {
  const result = await complete(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\nmystery["|"]\n'
  );
  assert.equal(result, undefined);
});

test('a subscript column is hoverable', async () => {
  const result = await hover(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf["reg|ion"]\n'
  );
  assert.match(result.contents.value, /\*\*region\*\* · `str`/);
});

test('a typo in a subscript is flagged', async () => {
  const { items } = await diagnose(
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf["regoin"]\n'
  );
  assert.equal(items.length, 1);
  assert.match(items[0].message, /Did you mean "region"/);
});

test('a dict key is never flagged as a bad column', async () => {
  const { items } = await diagnose(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'cfg = {"path": "x"}\n' +
    'value = cfg["anything_at_all"]\n'
  );
  assert.deepEqual(items, []);
});

// --- values: the one feature that reads data, and only when asked ---

async function withValues(fn) {
  setSetting(vscode, 'values.enable', true);
  try {
    return await fn();
  } finally {
    setSetting(vscode, 'values.enable', false);
  }
}

const VALUES_PY = 'import polars as pl\ndf = pl.scan_parquet("values.parquet")\n';

test('values are not read until the setting says so', async () => {
  // And nothing else is offered in their place: a column name is never what
  // belongs on the right of an `==`.
  const result = await complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`);
  assert.equal(result, undefined);
});

test('with the setting on, a comparison offers the column\'s real values', async () => {
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`)
  );
  assert.deepEqual(result.items.map((i) => i.label), ['US', 'EU', 'APAC']);
  assert.equal(result.items[0].detail, 'value');
});

test('a constraint keyword takes values on its right-hand side', async () => {
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(region="|")\n`)
  );
  assert.deepEqual(result.items.map((i) => i.label), ['US', 'EU', 'APAC']);
});

test('is_in offers values inside the list', async () => {
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(pl.col("region").is_in(["EU", "|"]))\n`)
  );
  assert.deepEqual(result.items.map((i) => i.label), ['US', 'EU', 'APAC']);
});

test('str.contains offers the column\'s values', async () => {
  // A regex position, and the values are still what you are reaching for: the
  // list is a starting point to trim, not a finished pattern.
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(pl.col("region").str.contains("|"))\n`)
  );
  assert.deepEqual(result.items.map((i) => i.label), ['US', 'EU', 'APAC']);
  assert.equal(result.items[0].detail, 'value');
});

test('starts_with and ends_with take values too', async () => {
  for (const method of ['starts_with', 'ends_with']) {
    const result = await withValues(() =>
      complete(`${VALUES_PY}df.filter(pl.col("region").str.${method}("|"))\n`)
    );
    assert.deepEqual(result.items.map((i) => i.label), ['US', 'EU', 'APAC'], method);
  }
});

test('a selector of the same name still offers column names', async () => {
  // `cs.contains("…")` is a fragment of a *name*. Values here would be the
  // feature answering a question nobody asked.
  const result = await complete(
    'import polars as pl\nimport polars.selectors as cs\n' +
    'df = pl.scan_parquet("values.parquet")\ndf.select(cs.contains("|"))\n'
  );
  assert.ok(result.items.some((i) => i.label === 'region'));
  assert.ok(!result.items.some((i) => i.label === 'EU'));
});

test('a high-cardinality column offers nothing at all', async () => {
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(pl.col("order_id") == "|")\n`)
  );
  assert.equal(result, undefined);
});

test('a column whose values are not strings offers nothing', async () => {
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.filter(pl.col("revenue") == "|")\n`)
  );
  assert.equal(result, undefined);
});

test('a column renamed on the way here has no values in the file', async () => {
  // The frame calls it `r`; the file has never heard of it. Offering `region`'s
  // values under the new name would be inventing the join between them.
  const result = await withValues(() =>
    complete(`${VALUES_PY}df.rename({"region": "r"}).filter(pl.col("r") == "|")\n`)
  );
  assert.equal(result, undefined);
});

test('hive partition values come from the directory names, complete', async () => {
  const result = await withValues(() =>
    complete('import polars as pl\ndf = pl.scan_parquet("hive")\ndf.filter(pl.col("region") == "|")\n')
  );
  assert.deepEqual(result.items.map((i) => i.label), ['EU', 'US']);
  // Not a sample: the partitioning is the whole list of values.
  assert.equal(result.items[0].detail, 'value');
});

test('a sampled list says so, on the item the user is looking at', async () => {
  // The first ten rows of values.parquet are all APAC. Offering that as if it
  // were the column would be the feature lying; the detail is where it owns up.
  setSetting(vscode, 'values.maxRows', 10);
  try {
    const result = await withValues(() =>
      complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`)
    );
    assert.deepEqual(result.items.map((i) => i.label), ['APAC']);
    assert.equal(result.items[0].detail, 'value (sampled)');
    assert.match(result.items[0].documentation.value, /first 10 rows/);
  } finally {
    setSetting(vscode, 'values.maxRows', 10000);
  }
});

test('the palette commands turn value completion on and off', async () => {
  const run = (id) => vscode._registered.commands.get(id)();
  try {
    await run('polarsense.enableValues');
    const on = await complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`);
    assert.deepEqual(on.items.map((i) => i.label), ['US', 'EU', 'APAC']);

    await run('polarsense.disableValues');
    assert.equal(await complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`), undefined);
  } finally {
    setSetting(vscode, 'values.enable', false);
  }
});

test('the toggle says what is wrong when the setting is not registered', async () => {
  // A window that resolved one copy of the extension and registered another's
  // manifest has the command but not the key. VS Code answers `update` with
  // "polarsense.values.enable is not a registered configuration", which reads
  // as a broken command; the toggle should name the actual fault instead, and
  // must not leave value completion half on.
  unregisterSetting(vscode, 'values.enable');
  vscode._registered.error = undefined;
  try {
    await vscode._registered.commands.get('polarsense.enableValues')();
    assert.match(vscode._registered.error ?? '', /not registered/);
    assert.equal(vscode._settings['values.enable'], false, 'the setting was written anyway');
    assert.equal(await complete(`${VALUES_PY}df.filter(pl.col("region") == "|")\n`), undefined);
  } finally {
    vscode._registered.unregistered.delete('values.enable');
    vscode._registered.error = undefined;
  }
});

test('a value is never warned about as an unknown column', async () => {
  const { items } = await withValues(() =>
    diagnose(`${VALUES_PY}df.filter(pl.col("region") == "nope")\n`)
  );
  assert.deepEqual(items, []);
});

test('hovering a value says nothing about columns', async () => {
  const result = await withValues(() =>
    hover(`${VALUES_PY}df.filter(pl.col("region") == "U|S")\n`)
  );
  assert.equal(result, undefined);
});


/**
 * The exported API, driven the way another extension would drive it: a uri and
 * a position, with the document open in the window as it always is when someone
 * is looking at it.
 */
async function resolveFrame(marked, fileDir = DATA) {
  const { document, position } = makeDocument(marked, path.join(fileDir, 'script.py'));
  vscode.workspace.textDocuments.push(document);
  try {
    return await api.resolveFrameAt(document.uri, position);
  } finally {
    vscode.workspace.textDocuments.length = 0;
  }
}

test('activate() returns the resolver as an API object', () => {
  assert.equal(api?.version, 1);
  assert.equal(typeof api.resolveFrameAt, 'function');
});

test('the API resolves the frame under the cursor to its file and columns', async () => {
  const frame = await resolveFrame(
    'import polars as pl\nd|f = pl.scan_parquet("sales.parquet")\n'
  );
  assert.equal(frame.uri, path.join(DATA, 'sales.parquet'));
  assert.equal(frame.kind, 'parquet');
  assert.equal(frame.symbol, 'df');
  assert.deepEqual(frame.columns.map((c) => c.name).slice(0, 2), ['region', 'revenue']);
  assert.equal(frame.certain, true);
  assert.equal(frame.transformed, false);
  assert.ok(frame.rowCount > 0);
});

test('the API answers with the columns at the cursor, and says they were narrowed', async () => {
  // A viewer showing this frame is showing the file, not the select — which is
  // the thing it has to admit in its header, so the flag has to reach it.
  const frame = await resolveFrame(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'out = df.select("region", "units").filter(pl.col("units") > 1)\n' +
    'print(ou|t)\n'
  );
  assert.deepEqual(frame.columns.map((c) => c.name), ['region', 'units']);
  assert.equal(frame.transformed, true);
  assert.equal(frame.certain, true);
  assert.equal(frame.uri, path.join(DATA, 'sales.parquet'));
});

test('the API carries the statistics the file already gave up', async () => {
  const frame = await resolveFrame(
    'import polars as pl\nd|f = pl.scan_parquet("sales.parquet")\n'
  );
  const revenue = frame.columns.find((c) => c.name === 'revenue');
  assert.equal(revenue.dtype, 'f64');
  assert.equal(typeof revenue.stats.nullCount, 'number');
});

test('an unmodelled reshape reaches the API as an uncertain answer', async () => {
  const frame = await resolveFrame(
    'import polars as pl\n' +
    'df = pl.read_parquet("sales.parquet")\n' +
    'wide = df.pivot(on="region", index="units")\n' +
    'print(wid|e)\n'
  );
  assert.equal(frame.certain, false);
});

test('the API says nothing where there is no frame', async () => {
  assert.equal(
    await resolveFrame('import polars as pl\ntot|al = 1 + 2\n'),
    undefined
  );
  // A frame whose file is not there is a "no", not a schema-less answer.
  assert.equal(
    await resolveFrame('import polars as pl\nd|f = pl.scan_parquet("missing.parquet")\n'),
    undefined
  );
});

/**
 * The details panel, driven the way the palette drives it: a cursor in an open
 * editor, and whatever the command put in the webview afterwards.
 */
async function details(marked, fileDir = DATA) {
  const { document, position } = makeDocument(marked, path.join(fileDir, 'script.py'));
  vscode.workspace.textDocuments.push(document);
  vscode.window.activeTextEditor = { document, selection: { active: position } };
  vscode._registered.info = undefined;
  try {
    await vscode._registered.commands.get('polarsense.showDetails')();
    const panel = vscode._registered.webviews.at(-1);
    return { html: panel?.webview.html ?? '', panel, message: vscode._registered.info };
  } finally {
    vscode.workspace.textDocuments.length = 0;
    vscode.window.activeTextEditor = undefined;
  }
}

test('the details panel lists every column with the statistics the footer held', async () => {
  const { html, panel } = await details(
    'import polars as pl\nd|f = pl.scan_parquet("sales.parquet")\n'
  );
  assert.equal(panel.title, 'sales.parquet');
  // Beside, and without taking focus: it is read while typing continues.
  assert.deepEqual(panel.revealed, { column: vscode.ViewColumn.Beside, preserveFocus: true });
  assert.match(html, /<td class="name">region<\/td>/);
  assert.match(html, /<td class="dtype">f64<\/td>/);
  // Nothing on this page runs: a column name comes out of a data file.
  assert.equal(panel.options.enableScripts, false);
  assert.doesNotMatch(html, /<script/);
});

test('the panel names the file and what the footer says about it', async () => {
  const { html } = await details(
    'import polars as pl\nd|f = pl.scan_parquet("sales.parquet")\n'
  );
  assert.match(html, /sales\.parquet/);
  assert.match(html, /<li>\d+ rows<\/li>/);
  assert.match(html, /<li>9 columns<\/li>/);
  assert.match(html, /<li>1 row group<\/li>/);
  assert.match(html, /<li>zstd<\/li>/);
  assert.match(html, /<li>[\d.]+ (B|KB|MB)<\/li>/);
});

test('a statistic the writer did not record is blank, not zero', async () => {
  // A CSV has no footer at all, so the panel is a list of names and says so by
  // having no columns to say it in — the one thing it must not do is print 0.
  const { html } = await details('import polars as pl\nd|f = pl.read_csv("sales.csv")\n');
  assert.match(html, /<td class="name">is_active<\/td>/);
  assert.doesNotMatch(html, /<th>Nulls<\/th>/);
  assert.doesNotMatch(html, /<td class="num">0<\/td>/);
});

test('a transformed frame says the numbers are the file’s, not the frame’s', async () => {
  const { html } = await details(
    'import polars as pl\n' +
    'df = pl.scan_parquet("sales.parquet")\n' +
    'out = df.select("region", "units").filter(pl.col("units") > 1)\n' +
    'print(ou|t)\n'
  );
  assert.match(html, /<td class="name">region<\/td>/);
  assert.doesNotMatch(html, /<td class="name">revenue<\/td>/);
  assert.match(html, /transforms not applied/);
  assert.match(html, /nothing here applies the transforms/);
});

test('an unmodelled reshape is shown as approximate', async () => {
  const { html } = await details(
    'import polars as pl\n' +
    'df = pl.read_parquet("sales.parquet")\n' +
    'wide = df.pivot(on="region", index="units")\n' +
    'print(wid|e)\n'
  );
  assert.match(html, /approximate/);
});

test('a column name out of a data file cannot carry markup into the panel', async () => {
  // The names on this page are written by whoever wrote the file. Scripts are
  // off, but an unescaped `<` would still wreck the table it sits in.
  const dir = mkdtempSync(path.join(tmpdir(), 'polarsense-'));
  writeFileSync(path.join(dir, 'evil.csv'), '<script>x</script>,a & b\n1,2\n');
  const { html } = await details('import polars as pl\nd|f = pl.read_csv("evil.csv")\n', dir);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.doesNotMatch(html, /<script>/);
});

test('the panel is not opened where there is no frame at the cursor', async () => {
  const before = vscode._registered.webviews.length;
  const { message } = await details('import polars as pl\ntot|al = 1 + 2\n');
  assert.equal(vscode._registered.webviews.length, before, 'a panel was opened anyway');
  assert.match(message ?? '', /no frame at the cursor/);
});

/**
 * The data panel, driven the way the webview drives it: the command opens it,
 * the page says it is ready, and every click after that is a message. What the
 * host sent to be drawn is the payload — the shell itself holds no data.
 */
async function openData(marked, fileDir = DATA) {
  const { document, position } = makeDocument(marked, path.join(fileDir, 'script.py'));
  vscode.workspace.textDocuments.push(document);
  vscode.window.activeTextEditor = { document, selection: { active: position } };
  vscode._registered.info = undefined;
  try {
    await vscode._registered.commands.get('polarsense.showData')();
    const panel = vscode._registered.webviews.find((p) => p.viewType === 'polarsense.data');
    if (!panel) return { panel: undefined, message: vscode._registered.info };
    panel.messages.length = 0;
    await panel.receive({ type: 'ready' });
    return {
      panel,
      payload: panel.messages.at(-1),
      // A click, a filter, a column step: the same door in.
      nav: async (patch) => {
        await panel.receive(patch);
        return panel.messages.at(-1);
      }
    };
  } finally {
    vscode.workspace.textDocuments.length = 0;
    vscode.window.activeTextEditor = undefined;
  }
}

const VALUES_PARQUET =
  'import polars as pl\nd|f = pl.scan_parquet("values.parquet")\n';

test('the data panel sends one page, and only the cells it draws', async () => {
  const { payload, panel } = await openData(VALUES_PARQUET);
  assert.equal(payload.rowStart, 0);
  assert.equal(payload.rowCount, 200);
  assert.equal(payload.rows.length, payload.pageSize, 'a page is a page, not the file');
  assert.equal(payload.more, true);
  for (const row of payload.rows) assert.equal(row.length, payload.columns.length);
  // The shell is a shell: the rows arrive as data, never as markup.
  assert.doesNotMatch(panel.webview.html, /ord-0000/);
  assert.match(panel.webview.html, /acquireVsCodeApi/);
});

test('paging moves a page at a time and stops at the end of the file', async () => {
  const { payload, nav } = await openData(VALUES_PARQUET);
  assert.equal(payload.rows[0][payload.columns.indexOf('region')], 'APAC');

  const second = await nav({ rowStart: 100 });
  assert.equal(second.rowStart, 100);
  assert.equal(second.rows.length, 100);
  assert.equal(second.more, false, 'there is nothing after row 199');
  // 40 APAC, 60 EU, 100 US: row 100 is the first US row.
  assert.equal(second.rows[0][second.columns.indexOf('region')], 'US');
  assert.equal(second.rows[0][second.columns.indexOf('order_id')], 'ord-0100');
});

test('a null cell crosses as a null, not as the word null', async () => {
  const { payload } = await openData(VALUES_PARQUET);
  const empty = payload.columns.indexOf('empty');
  assert.equal(payload.rows[0][empty], null);
});

test('a wide frame is navigated by column, and the filter narrows it', async () => {
  const { payload, nav } = await openData(
    'import polars as pl\nd|f = pl.scan_parquet("wide.parquet")\n'
  );
  assert.equal(payload.columnCount, 5000);
  assert.equal(payload.columns.length, payload.columnWindow, 'the whole file was drawn');
  assert.equal(payload.columns[0], 'col_0000');

  const stepped = await nav({ columnStart: payload.columnWindow });
  assert.equal(stepped.columns[0], 'col_0040');
  assert.equal(stepped.rows[0].length, stepped.columns.length);

  const narrowed = await nav({ filter: 'col_012' });
  assert.deepEqual(narrowed.columns, Array.from({ length: 10 }, (_, i) => `col_012${i}`));
  assert.equal(narrowed.columnStart, 0, 'a narrower list makes the old window meaningless');
});

test('a CSV page says it is a prefix of the file rather than the file', async () => {
  setSetting(vscode, 'csv.sniffBytes', 160);
  try {
    const { payload } = await openData('import polars as pl\nd|f = pl.read_csv("sales.csv")\n');
    assert.equal(payload.rowCount, undefined, 'a CSV has no row count to claim');
    assert.ok(payload.rows.length >= 1);
    assert.ok(
      payload.notes.some((note) => /prefix, not the file/.test(note)),
      `the prefix was not admitted to: ${JSON.stringify(payload.notes)}`
    );
  } finally {
    setSetting(vscode, 'csv.sniffBytes', 262144);
  }
});

test('a format whose rows are not read yet says so instead of showing an empty grid', async () => {
  const { payload } = await openData('import polars as pl\nd|f = pl.scan_ipc("sales.arrow")\n');
  assert.match(payload.error ?? '', /ipc/);
  assert.deepEqual(payload.rows, []);
  // The schema is still known — that is the point of saying which half is missing.
  assert.ok(payload.facts.some((fact) => /columns/.test(fact)));
});

test('a transformed frame still says the rows are the file’s', async () => {
  const { payload } = await openData(
    'import polars as pl\n' +
    'df = pl.scan_parquet("values.parquet")\n' +
    'out = df.filter(pl.col("region") == "EU")\n' +
    'print(ou|t)\n'
  );
  assert.equal(payload.rows.length, 100);
  assert.ok(payload.facts.includes('transforms not applied'));
  assert.ok(payload.notes.some((note) => /nothing here applies the transforms/.test(note)));
});

/**
 * The buttons under a cell's output. Nothing here runs Python: the renderer
 * says which output was clicked, the cell's own source says which frame that
 * is, and the panels are the same two the command palette opens.
 */
const POLARS_REPR =
  '<div><style>...</style><small>shape: (3, 9)</small>' +
  '<table border="1" class="dataframe"><thead><tr><th>region</th></tr></thead>' +
  '<tbody><tr><td>EU</td></tr></tbody></table></div>';

test('a frame repr is recognised and an ordinary HTML output is left alone', () => {
  assert.equal(looksLikeFrame(POLARS_REPR), true);
  // pandas writes the same class, which is why one test covers both.
  assert.equal(looksLikeFrame('<table border="1" class="dataframe">\n<tbody></tbody></table>'), true);
  // The negative case is the point: every HTML output in the notebook comes
  // through this renderer, and a button on a chart would be a lie.
  assert.equal(looksLikeFrame('<div id="fig"><script>Plotly.newPlot()</script></div>'), false);
  assert.equal(looksLikeFrame('<table><tr><td>a</td></tr></table>'), false);
  assert.equal(looksLikeFrame('<p>shape: (3, 9)</p>'), false);
});

test('the frame a cell printed is its last statement, past blanks and comments', () => {
  const source = 'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\ndf.head()\n\n# done\n';
  assert.equal(source.slice(lastStatementOffset(source), lastStatementOffset(source) + 9), 'df.head()');
  // Indentation belongs to the block, not to the statement inside it.
  const indented = 'if True:\n    df\n';
  assert.equal(indented.slice(lastStatementOffset(indented)), 'df\n');
  assert.equal(lastStatementOffset('\n\n# nothing here\n'), undefined);
});

/**
 * A click under an output, end to end: the renderer posts, the host finds the
 * cell, and the panel opens on the frame that cell built.
 */
async function clickButton(command, sources, { outputId, focus } = {}) {
  const { notebook, editor, documents, focus: focusOn } =
    makeNotebook(sources, path.join(DATA, 'analysis.ipynb'));
  if (focus !== undefined) focusOn(focus);
  vscode.workspace.notebookDocuments.push(notebook);
  vscode.workspace.textDocuments.push(...documents);
  vscode._registered.info = undefined;
  try {
    await vscode._registered.renderer.receive({ editor, message: { command, outputId } });
    return { message: vscode._registered.info };
  } finally {
    vscode.workspace.notebookDocuments.length = 0;
    vscode.workspace.textDocuments.length = 0;
  }
}

/** What the data panel was told to draw after a click, the way the page asks for it. */
async function drawnAfterClick(...args) {
  const { message } = await clickButton('showData', ...args);
  const panel = vscode._registered.webviews.find((p) => p.viewType === 'polarsense.data');
  panel.messages.length = 0;
  await panel.receive({ type: 'ready' });
  return { payload: panel.messages.at(-1), message };
}

test('a button under a cell opens the panel on the frame that cell printed', async () => {
  const { payload } = await drawnAfterClick([
    'import polars as pl\ndf = pl.scan_parquet("values.parquet")\n',
    'df.head()\n'
  ], { outputId: 'out-1' });
  assert.equal(payload.file, 'values.parquet');
  assert.equal(payload.rows.length, 100);
  // The frame was defined in an earlier cell: the assembler reads the notebook
  // as one module, so the button works without the cell having been run.
  assert.ok(payload.columns.includes('region'));
});

test('the output that was clicked wins over the cell that happens to be focused', async () => {
  const { payload } = await drawnAfterClick([
    'import polars as pl\ndf = pl.scan_parquet("values.parquet")\nwide = pl.scan_parquet("wide.parquet")\n',
    'df\n',
    'wide\n'
  ], { outputId: 'out-1', focus: 2 });
  assert.equal(payload.file, 'values.parquet');
});

test('an output id the API never exposed falls back to the focused cell', async () => {
  // NotebookCellOutput carries no id in the typed API, so the match can miss.
  // Clicking inside an output is what focuses its cell, which is the answer.
  const { payload } = await drawnAfterClick([
    'import polars as pl\ndf = pl.scan_parquet("values.parquet")\nwide = pl.scan_parquet("wide.parquet")\n',
    'df\n',
    'wide\n'
  ], { outputId: 'not-an-output', focus: 2 });
  assert.equal(payload.file, 'wide.parquet');
});

test('the details panel opens from a cell too, with no rows read', async () => {
  const { message } = await clickButton('showDetails', [
    'import polars as pl\ndf = pl.scan_parquet("sales.parquet")\n',
    'df.select("region", "units")\n'
  ], { outputId: 'out-1' });
  assert.equal(message, undefined, `the panel said: ${message}`);
  const panel = vscode._registered.webviews.find((p) => p.viewType === 'polarsense.details');
  assert.match(panel.webview.html, /<td class="name">region<\/td>/);
  // A select is a transform, and the file behind it is what the panel shows.
  assert.match(panel.webview.html, /transforms not applied/);
});

test('a cell whose frame has no file behind it says so instead of opening', async () => {
  const before = vscode._registered.webviews.length;
  const { message } = await clickButton('showDetails', [
    'import polars as pl\ndf = pl.DataFrame({"a": [1, 2]})\n',
    'df\n'
  ], { outputId: 'out-1' });
  assert.match(message ?? '', /no file behind it/);
  assert.equal(vscode._registered.webviews.length, before, 'a panel was opened anyway');
});

test('a page that has just loaded is told whether the buttons are on', async () => {
  const wire = vscode._registered.renderer;
  const { editor } = makeNotebook(['df\n'], path.join(DATA, 'analysis.ipynb'));
  wire.posted.length = 0;
  await wire.receive({ editor, message: { type: 'ready' } });
  assert.deepEqual(wire.posted.at(-1).message, { type: 'config', buttons: true });

  setSetting(vscode, 'notebook.buttons', false);
  try {
    // Turning them off reaches the outputs already drawn, not only the next one.
    assert.deepEqual(wire.posted.at(-1).message, { type: 'config', buttons: false });
  } finally {
    setSetting(vscode, 'notebook.buttons', true);
  }
});
