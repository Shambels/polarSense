import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveMarked, analyzeSource, resolveAtOffset, evaluateFrame, sqlTables, sqlColumnPosition
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PL = 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\n';
const DD = 'import duckdb\n';

/** `|` marks the cursor; the expected value is the file its table reads. */
const CASES = [
  ['df.sql and FROM self', `${PL}df.sql("SELECT | FROM self")`, 'a.parquet'],
  ['a column part-typed', `${PL}df.sql("SELECT regi| FROM self")`, 'a.parquet'],
  ['in a WHERE clause', `${PL}df.sql("SELECT * FROM self WHERE | > 1")`, 'a.parquet'],
  ['in GROUP BY', `${PL}df.sql("SELECT * FROM self GROUP BY |")`, 'a.parquet'],
  ['self is case-insensitive', `${PL}df.sql("SELECT | FROM SELF")`, 'a.parquet'],
  ['a chained frame', `${PL}df.filter(x).sql("SELECT | FROM self")`, 'a.parquet'],

  ['pl.sql naming a Python frame', `${PL}pl.sql("SELECT | FROM df")`, 'a.parquet'],
  ['a lowercase from', `${PL}pl.sql("select | from df")`, 'a.parquet'],
  ['an aliased table', `${PL}pl.sql("SELECT | FROM df AS d")`, 'a.parquet'],
  ['a bare alias', `${PL}pl.sql("SELECT | FROM df d")`, 'a.parquet'],

  ['SQLContext keyword', `${PL}pl.SQLContext(sales=df).execute("SELECT | FROM sales")`, 'a.parquet'],
  ['SQLContext held in a variable', `${PL}ctx = pl.SQLContext(sales=df)\nctx.execute("SELECT | FROM sales")`, 'a.parquet'],
  ['SQLContext with a dict', `${PL}pl.SQLContext({"sales": df}).execute("SELECT | FROM sales")`, 'a.parquet'],
  ['a chained register', `${PL}pl.SQLContext().register("sales", df).execute("SELECT | FROM sales")`, 'a.parquet'],

  ['duckdb reading a file', `${DD}duckdb.sql("SELECT | FROM 'a.parquet'")`, 'a.parquet'],
  ['duckdb read_parquet in SQL', `${DD}duckdb.sql("SELECT | FROM read_parquet('a.parquet')")`, 'a.parquet'],
  ['a connection', `${DD}con = duckdb.connect()\ncon.execute("SELECT | FROM 'a.parquet'")`, 'a.parquet'],
  ['a triple-quoted statement', `${PL}df.sql("""\nSELECT |\nFROM self\n""")`, 'a.parquet'],
  ['a statement with an escaped newline', `${PL}df.sql("SELECT |\\nFROM self")`, 'a.parquet']
];

for (const [name, snippet, expected] of CASES) {
  test(`sql: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, expected, `failure was: ${res.failure ?? 'none'}`);
  });
}

test('a qualified name picks its own table', async () => {
  const source =
    'import polars as pl\n' +
    'a = pl.scan_parquet("a.parquet")\n' +
    'b = pl.scan_parquet("b.parquet")\n' +
    'pl.sql("SELECT y. FROM a x JOIN b y ON x.id = y.id")';
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.indexOf('y. FROM') + 2);
  assert.equal(res.source?.path, 'b.parquet');
});

test('an unqualified name in a join sees both tables, and says it is unsure', async () => {
  const source =
    'import polars as pl\n' +
    'a = pl.scan_parquet("a.parquet")\n' +
    'b = pl.scan_parquet("b.parquet")\n' +
    'pl.sql("SELECT  FROM a JOIN b ON a.id = b.id")';
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.indexOf('SELECT  FROM') + 7);
  assert.ok(res.frame, 'no frame resolved');

  const columns = {
    'a.parquet': [{ name: 'id', dtype: 'i64' }, { name: 'region', dtype: 'str' }],
    'b.parquet': [{ name: 'id', dtype: 'i64' }, { name: 'revenue', dtype: 'f64' }]
  };
  const evaluated = evaluateFrame(res.frame, (s) => columns[s.path], table);
  // The shared name is offered once — in SQL the two are the same reference.
  assert.deepEqual(evaluated.columns.map((c) => c.name), ['id', 'region', 'revenue']);
  assert.equal(evaluated.certain, false, 'which table a bare name belongs to is a guess');
});

test('only the word under the cursor is replaced', async () => {
  const source = `${PL}df.sql("SELECT region, reve FROM self")`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const at = source.indexOf('reve');
  const res = resolveAtOffset(tree, table, at + 4);
  assert.equal(source.slice(res.contentStart, res.contentEnd), 'reve');
});

test('a fragment argument narrows to its word too', async () => {
  // The same fix reaches `rel.project("region, reve")`, which used to replace
  // the whole string with whichever column was accepted.
  const source = 'import duckdb\nrel = duckdb.read_parquet("a.parquet")\nrel.project("region, reve")';
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.indexOf('reve') + 4);
  assert.equal(source.slice(res.contentStart, res.contentEnd), 'reve');
  assert.equal(res.partial, true);
});

test('SQL positions are never typo-checked', async () => {
  const res = await resolveMarked(`${PL}df.sql("SELECT | FROM self")`, ROOT);
  assert.equal(res.partial, true);
});

const NOTHING = [
  ['the table name itself', `${PL}pl.sql("SELECT * FROM |")`],
  ['a named table', `${PL}pl.sql("SELECT * FROM d|f")`],
  ['a quoted path', `${DD}duckdb.sql("SELECT * FROM '|a.parquet'")`],
  ['a string value in a comparison', `${PL}df.sql("SELECT * FROM self WHERE region = '|EU'")`],
  ['inside a SQL comment', `${PL}df.sql("SELECT * FROM self -- | note")`],
  ['a table we cannot resolve', `${PL}pl.sql("SELECT | FROM mystery")`]
];

for (const [name, snippet] of NOTHING) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, undefined, 'unexpectedly resolved');
  });
}

test('a pandas query is not SQL', async () => {
  // No FROM clause, so it stays an ordinary fragment argument against the
  // receiver rather than being read as a statement.
  const res = await resolveMarked(
    'import pandas as pd\ndf = pd.read_parquet("a.parquet")\ndf.query("reve| > 100")',
    ROOT
  );
  assert.equal(res.source?.path, 'a.parquet');
  assert.equal(res.partial, true);
});

// --- the scan on its own ---

test('finds the tables a statement reads', () => {
  const got = sqlTables('SELECT * FROM sales s JOIN dim AS d ON s.id = d.id');
  assert.deepEqual(got.map((t) => [t.name, t.alias]), [['sales', 's'], ['dim', 'd']]);
});

test('a comma-separated list is several tables', () => {
  const got = sqlTables('SELECT * FROM a, b, c');
  assert.deepEqual(got.map((t) => t.name), ['a', 'b', 'c']);
});

test('a keyword after a table is not its alias', () => {
  const got = sqlTables('SELECT * FROM sales WHERE x = 1');
  assert.deepEqual(got.map((t) => [t.name, t.alias]), [['sales', null]]);
});

test('a quoted table is a file', () => {
  const got = sqlTables("SELECT * FROM 'data/sales.parquet'");
  assert.equal(got[0].path, 'data/sales.parquet');
  assert.equal(got[0].kind, 'parquet');
});

test('a reader call is a file, with its own format', () => {
  const got = sqlTables("SELECT * FROM read_csv('data/sales.csv') t");
  assert.equal(got[0].path, 'data/sales.csv');
  assert.equal(got[0].kind, 'csv');
  assert.equal(got[0].alias, 't');
});

test('a subquery contributes its own tables, not itself', () => {
  const got = sqlTables('SELECT * FROM (SELECT * FROM sales) t');
  assert.deepEqual(got.map((t) => t.name), ['sales']);
});

test('a statement with no FROM has no tables', () => {
  assert.deepEqual(sqlTables('revenue > 100'), []);
  assert.deepEqual(sqlTables('SELECT 1'), []);
});

test('a table name in a string is not a table', () => {
  assert.deepEqual(sqlTables("SELECT * FROM sales WHERE note = 'from elsewhere'").length, 1);
});

test('column positions are told apart from everything else', () => {
  const sql = "SELECT region FROM sales WHERE note = 'x' -- from here";
  const tables = sqlTables(sql);
  assert.ok(sqlColumnPosition(sql, sql.indexOf('region') + 2, tables));
  assert.equal(sqlColumnPosition(sql, sql.indexOf('sales') + 2, tables), null);
  assert.equal(sqlColumnPosition(sql, sql.indexOf("'x'") + 1, tables), null);
  assert.equal(sqlColumnPosition(sql, sql.indexOf('-- from') + 4, tables), null);
});

test('a qualifier is read back off the text', () => {
  const sql = 'SELECT s.region FROM sales s';
  const got = sqlColumnPosition(sql, sql.indexOf('region') + 3, sqlTables(sql));
  assert.equal(got.qualifier, 's');
  assert.equal(sql.slice(got.wordStart, got.wordEnd), 'region');
});
