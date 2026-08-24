import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarked } from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'import polars as pl\n';

/** `|` marks the cursor. Expected value is the path the frame resolves to. */
const CASES = [
  // --- the walking skeleton ---
  ['literal chain', `${HEAD}pl.read_parquet("sales.parquet").select(pl.col("|"))`, 'sales.parquet'],
  ['bare select string', `${HEAD}pl.read_parquet("sales.parquet").select("|")`, 'sales.parquet'],

  // --- variable bindings ---
  ['simple binding', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select(pl.col("|"))`, 'a.parquet'],
  ['alias through filter', `${HEAD}df = pl.scan_parquet("a.parquet")\nrecent = df.filter(x)\nrecent.select(pl.col("|"))`, 'a.parquet'],
  ['two-step alias', `${HEAD}df = pl.scan_parquet("a.parquet")\nb = df.head()\nc = b.tail()\nc.group_by("|")`, 'a.parquet'],
  ['reassignment picks the latest', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf = pl.scan_parquet("b.parquet")\ndf.select("|")`, 'b.parquet'],
  ['earlier cursor sees earlier binding', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select("|")\ndf = pl.scan_parquet("b.parquet")`, 'a.parquet'],
  ['pl.concat takes the first frame', `${HEAD}a = pl.scan_parquet("a.parquet")\nb = pl.scan_parquet("b.parquet")\nc = pl.concat([a, b])\nc.select("|")`, 'a.parquet'],

  // --- constant folding ---
  ['module constant', `${HEAD}P = "data/a.parquet"\ndf = pl.scan_parquet(P)\ndf.select("|")`, 'data/a.parquet'],
  ['string concat', `${HEAD}D = "data/"\ndf = pl.scan_parquet(D + "a.parquet")\ndf.select("|")`, 'data/a.parquet'],
  ['f-string without interpolation', `${HEAD}df = pl.scan_parquet(f"data/a.parquet")\ndf.select("|")`, 'data/a.parquet'],
  ['pathlib division', `${HEAD}from pathlib import Path\nD = Path("data")\ndf = pl.scan_parquet(D / "a.parquet")\ndf.select("|")`, 'data/a.parquet'],
  ['os.path.join', `${HEAD}import os\nD = "data"\ndf = pl.scan_parquet(os.path.join(D, "a.parquet"))\ndf.select("|")`, 'data/a.parquet'],
  ['Path constructor', `${HEAD}from pathlib import Path\ndf = pl.scan_parquet(Path("data", "a.parquet"))\ndf.select("|")`, 'data/a.parquet'],

  // --- trigger sites ---
  ['with_columns', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.with_columns(pl.col("|"))`, 'a.parquet'],
  ['group_by then agg', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.group_by("region").agg(pl.col("|"))`, 'a.parquet'],
  ['sort by=', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.sort(by="|")`, 'a.parquet'],
  ['unique subset=', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.unique(subset=["|"])`, 'a.parquet'],
  ['rename dict key', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.rename({"|": "new"})`, 'a.parquet'],
  ['list argument', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select(["x", "|"])`, 'a.parquet'],
  ['exclude', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select(pl.exclude("|"))`, 'a.parquet'],
  ['over', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select(pl.col("x").sum().over("|"))`, 'a.parquet'],
  ['pivot on=', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.pivot(on="|", index="i", values="v")`, 'a.parquet'],
  ['from polars import col', `from polars import col, scan_parquet\nimport polars as pl\ndf = pl.scan_parquet("a.parquet")\ndf.select(col("|"))`, 'a.parquet'],
  ['custom polars alias', `import polars as polars_lib\ndf = polars_lib.scan_parquet("a.parquet")\ndf.select(polars_lib.col("|"))`, 'a.parquet'],

  // --- join: left and right resolve to different frames ---
  ['join on= uses the receiver', `${HEAD}a = pl.scan_parquet("a.parquet")\nb = pl.scan_parquet("b.parquet")\na.join(b, on="|")`, 'a.parquet'],
  ['join left_on= uses the receiver', `${HEAD}a = pl.scan_parquet("a.parquet")\nb = pl.scan_parquet("b.parquet")\na.join(b, left_on="|", right_on="y")`, 'a.parquet'],
  ['join right_on= uses the other frame', `${HEAD}a = pl.scan_parquet("a.parquet")\nb = pl.scan_parquet("b.parquet")\na.join(b, right_on="|")`, 'b.parquet'],

  // --- other formats ---
  ['csv', `${HEAD}df = pl.read_csv("a.csv")\ndf.select("|")`, 'a.csv'],
  ['delta', `${HEAD}df = pl.scan_delta("tbl")\ndf.select("|")`, 'tbl'],
  ['iceberg', `${HEAD}df = pl.scan_iceberg("tbl")\ndf.select("|")`, 'tbl'],

  // --- half-written code, which is the normal case ---
  ['unterminated string', `${HEAD}df = pl.scan_parquet("a.parquet")\nout = df.select(pl.col("|`, 'a.parquet'],
  ['unterminated with prefix typed', `${HEAD}df = pl.scan_parquet("a.parquet")\nout = df.select(pl.col("re|`, 'a.parquet'],
  ['empty string, quotes auto-closed', `${HEAD}df = pl.scan_parquet("a.parquet")\nout = df.select(pl.col("|"))`, 'a.parquet']
];

for (const [name, snippet, expected] of CASES) {
  test(`resolves: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, expected, `failure was: ${res.failure ?? 'none'}`);
  });
}

/** Positions that must NOT offer column names. */
const NEGATIVE = [
  ['rename dict value', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.rename({"old": "|"})`],
  ['the path argument itself', `${HEAD}df = pl.scan_parquet("|")`],
  ['alias creates a new name', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select(pl.col("x").alias("|"))`],
  ['unrelated function', `${HEAD}df = pl.scan_parquet("a.parquet")\nprint("|")`],
  ['a plain string statement', `${HEAD}x = "|"`]
];

for (const [name, snippet] of NEGATIVE) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source, undefined, `unexpectedly resolved to ${res.source?.path}`);
  });
}

/**
 * Known-wrong behaviour, asserted on purpose so that fixing it is a visible change
 * rather than a silent one. These are the v1 limitations from the plan.
 */
test('known limitation: schema transformations are not applied', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.scan_parquet("a.parquet")\nnarrow = df.select("x")\nnarrow.select("|")`,
    ROOT
  );
  // Ideally this would offer only "x"; today it offers everything in a.parquet.
  assert.equal(res.source?.path, 'a.parquet');
});

test('known limitation: a frame from a parameter is not resolved', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.scan_parquet("a.parquet")\ndef f(df):\n    return df.select("|")`,
    ROOT
  );
  assert.equal(res.source, undefined);
  assert.equal(res.failure, 'unknown-binding');
});

test('local binding shadows the module-level one', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.scan_parquet("outer.parquet")\ndef f():\n    df = pl.scan_parquet("inner.parquet")\n    return df.select("|")`,
    ROOT
  );
  assert.equal(res.source?.path, 'inner.parquet');
});

test('kwargs from the call site are carried through', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.read_csv("a.csv", separator=";", has_header=False)\ndf.select("|")`,
    ROOT
  );
  assert.equal(res.source?.kwargs.separator, ';');
  assert.equal(res.source?.kwargs.has_header, false);
});

test('every source in the file is offered for the fallback', async () => {
  const res = await resolveMarked(
    `${HEAD}a = pl.scan_parquet("a.parquet")\nb = pl.read_csv("b.csv")\ne = pl.col("|")`,
    ROOT
  );
  assert.equal(res.source, undefined);
  assert.deepEqual(res.allSources.map((s) => s.path).sort(), ['a.parquet', 'b.csv']);
});

test('the completion range covers the string contents only', async () => {
  const marked = `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.select("re|gion")`;
  const res = await resolveMarked(marked, ROOT);
  const source = marked.replace('|', '');
  assert.equal(source.slice(res.contentStart, res.contentEnd), 'region');
});

test('a list kwarg survives as a list, not a joined string', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.read_csv("a.csv", new_columns=["alpha", "beta"])\ndf.select("|")`,
    ROOT
  );
  assert.deepEqual(res.source?.kwargs.new_columns, ['alpha', 'beta']);
});
