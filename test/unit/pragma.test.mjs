import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveMarked, resolveProject, analyzeSource, initParser, parse,
  collectPragmas, evaluateFrame, resolveAtOffset
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PL = 'import polars as pl\n';

/** `|` marks the cursor; the expected value is the file the pragma names. */
const CASES = [
  ['above an unfoldable reader',
    `${PL}# polarsense: data/sales.parquet\ndf = pl.scan_parquet(cfg.source_path)\ndf.select("|")`,
    'data/sales.parquet'],

  ['trailing on the same line',
    `${PL}df = pl.scan_parquet(cfg.source_path)  # polarsense: data/sales.parquet\ndf.select("|")`,
    'data/sales.parquet'],

  ['a call we cannot see into',
    `${PL}df = get_frame()  # polarsense: a.parquet\ndf.select("|")`,
    'a.parquet'],

  ['a function parameter',
    `${PL}def report(df):  # polarsense: a.parquet\n    return df.select("|")`,
    'a.parquet'],

  ['above the def',
    `${PL}# polarsense: a.parquet\ndef report(df):\n    return df.select("|")`,
    'a.parquet'],

  ['a config attribute',
    `${PL}frames = load()\ndf = frames.sales  # polarsense: a.parquet\ndf.select("|")`,
    'a.parquet'],

  ['inside a multi-line statement',
    `${PL}df = pl.scan_parquet(\n    cfg.source_path\n)  # polarsense: a.parquet\ndf.select("|")`,
    'a.parquet'],

  ['at the use site rather than the binding',
    `${PL}def report(df):\n    return df.select("|")  # polarsense: a.parquet`,
    'a.parquet'],

  ['a quoted path, for one with spaces',
    `${PL}df = get_frame()  # polarsense: "my data/sales.parquet"\ndf.select("|")`,
    'my data/sales.parquet'],

  ['an explicit kind for a table directory',
    `${PL}df = get_frame()  # polarsense: delta data/warehouse/sales\ndf.select("|")`,
    'data/warehouse/sales'],

  ['extra spacing is not a different comment',
    `${PL}df = get_frame()  #   polarsense:   a.parquet\ndf.select("|")`,
    'a.parquet']
];

for (const [name, snippet, expected] of CASES) {
  test(`pragma: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, expected, `failure was: ${res.failure ?? 'none'}`);
  });
}

test('the code wins over the comment', async () => {
  // A pragma left behind after the path was made readable must not start lying.
  const res = await resolveMarked(
    `${PL}# polarsense: stale.parquet\ndf = pl.scan_parquet("real.parquet")\ndf.select("|")`,
    ROOT
  );
  assert.equal(res.source?.path, 'real.parquet');
});

test('the reader still decides the format and the options', async () => {
  // Only the path was missing; `separator` and the CSV-ness came from the call.
  const res = await resolveMarked(
    `${PL}df = pl.read_csv(cfg.path, separator=";")  # polarsense: a.parquet\ndf.select("|")`,
    ROOT
  );
  assert.equal(res.source?.kind, 'csv');
  assert.equal(res.source?.path, 'a.parquet');
  assert.equal(res.source?.kwargs.separator, ';');
});

test('an explicit kind beats the extension', async () => {
  const res = await resolveMarked(
    `${PL}df = get_frame()  # polarsense: iceberg tables/sales\ndf.select("|")`,
    ROOT
  );
  assert.equal(res.source?.kind, 'iceberg');
});

const KINDS = [
  ['a.parquet', 'parquet'],
  ['a.pq', 'parquet'],
  ['a.csv', 'csv'],
  ['a.tsv', 'csv'],
  ['a.arrow', 'ipc'],
  ['a.feather', 'ipc'],
  // A bare directory is most often a folder of parquet, and the path layer
  // already knows how to pick a file out of one.
  ['data/sales', 'parquet']
];

for (const [target, kind] of KINDS) {
  test(`pragma infers ${kind} from ${target}`, async () => {
    const res = await resolveMarked(
      `${PL}df = get_frame()  # polarsense: ${target}\ndf.select("|")`,
      ROOT
    );
    assert.equal(res.source?.kind, kind);
  });
}

const NOTHING = [
  ['a pragma on another statement',
    `${PL}# polarsense: a.parquet\nx = get_frame()\ndf = get_other()\ndf.select("|")`],
  ['a pragma below the statement it would have helped',
    `${PL}df = get_frame()\n# polarsense: a.parquet\nprint(df)\ndf.select("|")`],
  ['an ordinary comment',
    `${PL}df = get_frame()  # reads data/sales.parquet\ndf.select("|")`],
  ['a pragma with nothing after it',
    `${PL}df = get_frame()  # polarsense:\ndf.select("|")`],
  ['a pragma inside the body does not reach the parameter',
    `${PL}def report(df):\n    x = 1  # polarsense: a.parquet\n    return df.select("|")`]
];

for (const [name, snippet] of NOTHING) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, undefined, `unexpectedly resolved`);
  });
}

test('transforms still propagate from a pragma-named source', async () => {
  const source =
    `${PL}df = get_frame()  # polarsense: a.parquet\nn = df.select("a", "b")\nn.select("")`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.lastIndexOf('""') + 1);
  assert.ok(res.frame, 'no frame resolved');
  const columns = ['a', 'b', 'c'].map((name) => ({ name, dtype: 'i64' }));
  const evaluated = evaluateFrame(res.frame, () => columns, table);
  assert.deepEqual(evaluated.columns.map((c) => c.name), ['a', 'b']);
  assert.equal(evaluated.certain, true);
});

test('a pragma travels with the module it was written in', async () => {
  const res = await resolveProject({
    'loaders.py':
      `${PL}def load(cfg):\n    # polarsense: data/sales.parquet\n    return pl.scan_parquet(cfg.path)\n`,
    'main.py': 'from loaders import load\nload().select("|")'
  }, 'main.py', ROOT);
  assert.equal(res.source?.path, 'data/sales.parquet');
});

test('the path in a pragma is a document link', async () => {
  const source = `${PL}df = get_frame()  # polarsense: data/sales.parquet\n`;
  const { table } = await analyzeSource(source, ROOT);
  const site = table.sourceSites.find((s) => s.source.path === 'data/sales.parquet');
  assert.ok(site, 'no source site for the pragma');
  assert.equal(source.slice(site.start, site.end), 'data/sales.parquet');
});

test('pragmas are collected by the row they sit on', async () => {
  const parser = await initParser(ROOT);
  const tree = parse(parser, [
    '# polarsense: a.parquet',
    'x = 1  # polarsense: csv b.data',
    '# not a pragma'
  ].join('\n'));
  const got = collectPragmas(tree);
  assert.equal(got.size, 2);
  assert.equal(got.get(0).source.path, 'a.parquet');
  assert.equal(got.get(1).source.kind, 'csv');
  assert.equal(got.get(1).source.path, 'b.data');
});
