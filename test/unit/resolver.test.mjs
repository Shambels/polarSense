import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarked, analyzeSource } from '../harness.mjs';

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
  ['subscript', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf["|"]`, 'a.parquet'],
  ['subscript on a chain', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.filter(x)["|"]`, 'a.parquet'],
  ['subscript with a list', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf[["x", "|"]]`, 'a.parquet'],
  ['subscript with a tuple', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf["x", "|"]`, 'a.parquet'],
  ['get_column', `${HEAD}df = pl.scan_parquet("a.parquet")\ndf.get_column("|")`, 'a.parquet'],
  ['drop_in_place', `${HEAD}df = pl.read_parquet("a.parquet")\ndf.drop_in_place("|")`, 'a.parquet'],
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
  ['a plain string statement', `${HEAD}x = "|"`],
  // A dict subscript is structurally identical to a frame one, so the receiver
  // has to decide it — otherwise every cfg["key"] in the file offers columns.
  ['a dict subscript', `${HEAD}cfg = {"path": "x"}\ncfg["|"]`],
  ['an unknown receiver subscript', `${HEAD}mystery["|"]`],
  ['the object being subscripted', `${HEAD}frames = {}\nframes["|"]["b"]`]
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
test('a transformed frame keeps its source and records the transform', async () => {
  const res = await resolveMarked(
    `${HEAD}df = pl.scan_parquet("a.parquet")\nnarrow = df.select("x")\nnarrow.select("|")`,
    ROOT
  );
  // The file is still a.parquet; the frame remembers the select applied to it,
  // which is what narrows the offer downstream.
  assert.equal(res.source?.path, 'a.parquet');
  assert.equal(res.frame?.kind, 'transform');
  assert.equal(res.frame?.op.op, 'select');
  assert.equal(res.frame?.input.kind, 'source');
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

// --- path completion inside a reader's first argument ---
const PATH_SITES = [
  ['read_parquet positional', `${HEAD}pl.read_parquet("da|")`, 'parquet', 'da'],
  ['scan_csv positional', `${HEAD}pl.scan_csv("data/sa|")`, 'csv', 'data/sa'],
  ['source= keyword', `${HEAD}pl.scan_parquet(source="da|")`, 'parquet', 'da'],
  ['scan_delta is a table site', `${HEAD}pl.scan_delta("tb|")`, 'delta', 'tb'],
  ['empty prefix', `${HEAD}pl.read_parquet("|")`, 'parquet', '']
];

for (const [name, snippet, kind, prefix] of PATH_SITES) {
  test(`path site: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.pathSite?.kind, kind, `failure was: ${res.failure ?? 'none'}`);
    assert.equal(res.pathSite?.prefix, prefix);
    assert.equal(res.source, undefined, 'a path site must not also resolve a schema');
  });
}

test('the prefix stops at the cursor, not the end of the string', async () => {
  const res = await resolveMarked(`${HEAD}pl.read_parquet("data/sa|les.parquet")`, ROOT);
  assert.equal(res.pathSite?.prefix, 'data/sa');
});

test('a non-path argument of a reader is not a path site', async () => {
  const res = await resolveMarked(`${HEAD}pl.read_csv("a.csv", separator="|")`, ROOT);
  assert.equal(res.pathSite, undefined);
});

// --- reader call sites, used to turn paths into ctrl-clickable links ---
test('every reader call site is recorded with its path range', async () => {
  const source = `${HEAD}a = pl.scan_parquet("data/a.parquet")\nb = pl.read_csv("b.csv")\n`;
  const { table } = await analyzeSource(source, ROOT);
  const sites = table.sourceSites;
  assert.equal(sites.length, 2);
  assert.deepEqual(sites.map((s) => source.slice(s.start, s.end)), ['data/a.parquet', 'b.csv']);
  assert.deepEqual(sites.map((s) => s.source.kind), ['parquet', 'csv']);
});

test('a call site with an unfoldable path is not linkable', async () => {
  const { table } = await analyzeSource(`${HEAD}df = pl.scan_parquet(cfg.path)\n`, ROOT);
  assert.equal(table.sourceSites.length, 0);
});

test('a folded constant path still yields a link over the argument', async () => {
  const source = `${HEAD}P = "data/a.parquet"\ndf = pl.scan_parquet(P)\n`;
  const { table } = await analyzeSource(source, ROOT);
  assert.equal(table.sourceSites.length, 1);
  assert.equal(source.slice(table.sourceSites[0].start, table.sourceSites[0].end), 'P');
  assert.equal(table.sourceSites[0].source.path, 'data/a.parquet');
});

test('an inline reader chain is a call site too', async () => {
  const source = `${HEAD}out = pl.read_parquet("x.parquet").select("a")\n`;
  const { table } = await analyzeSource(source, ROOT);
  assert.equal(table.sourceSites.length, 1);
  assert.equal(source.slice(table.sourceSites[0].start, table.sourceSites[0].end), 'x.parquet');
});
