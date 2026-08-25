import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarked, dataPathInSql } from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PD = 'import pandas as pd\ndf = pd.read_parquet("a.parquet")\n';
const DD = 'import duckdb\n';

/** `|` marks the cursor; the expected value is the file the frame reads. */
const PANDAS = [
  ['groupby', `${PD}df.groupby("|")`],
  ['groupby by=', `${PD}df.groupby(by=["|"])`],
  ['sort_values', `${PD}df.sort_values("|")`],
  ['sort_values by=', `${PD}df.sort_values(by=["x", "|"])`],
  ['drop columns=', `${PD}df.drop(columns=["|"])`],
  ['rename columns= key', `${PD}df.rename(columns={"|": "new"})`],
  ['astype dict key', `${PD}df.astype({"|": "int64"})`],
  ['set_index', `${PD}df.set_index("|")`],
  ['drop_duplicates subset=', `${PD}df.drop_duplicates(subset=["|"])`],
  ['dropna subset=', `${PD}df.dropna(subset=["|"])`],
  ['nlargest names the column second', `${PD}df.nlargest(5, "|")`],
  ['value_counts', `${PD}df.value_counts("|")`],
  ['pivot_table index=', `${PD}df.pivot_table(index="|", values="v")`],
  ['agg dict key', `${PD}df.groupby("region").agg({"|": "sum"})`],
  ['subscript list', `${PD}df[["x", "|"]]`],
  ['a chain', `${PD}df.dropna().sort_values("|")`],
  ['a frame from a merge', `${PD}other = pd.read_parquet("b.parquet")\ndf.merge(other, on="|")`]
];

for (const [name, snippet] of PANDAS) {
  test(`pandas: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, 'a.parquet', `failure was: ${res.failure ?? 'none'}`);
  });
}

test('pandas reads CSV as readily as parquet', async () => {
  const res = await resolveMarked(
    'import pandas as pd\ndf = pd.read_csv("a.csv")\ndf.groupby("|")',
    ROOT
  );
  assert.equal(res.source?.path, 'a.csv');
  assert.equal(res.source?.kind, 'csv');
});

test('pandas merge right_on completes from the other frame', async () => {
  const res = await resolveMarked(
    `${PD}other = pd.read_parquet("b.parquet")\ndf.merge(other, right_on="|")`,
    ROOT
  );
  assert.equal(res.source?.path, 'b.parquet');
});

test('pandas spells the CSV options its own way', async () => {
  const res = await resolveMarked(
    'import pandas as pd\ndf = pd.read_csv("a.csv", sep=";", header=None)\ndf.groupby("|")',
    ROOT
  );
  assert.equal(res.source?.kwargs.separator, ';');
  assert.equal(res.source?.kwargs.has_header, false);
});

test('a pandas header row is still a header row', async () => {
  const res = await resolveMarked(
    'import pandas as pd\ndf = pd.read_csv("a.csv", header=0)\ndf.groupby("|")',
    ROOT
  );
  assert.equal(res.source?.kwargs.has_header, true);
});

const DUCKDB = [
  ['a quoted parquet path in SQL', `${DD}rel = duckdb.sql("SELECT * FROM 'a.parquet'")\nrel.project("|")`],
  ['read_parquet inside SQL', `${DD}rel = duckdb.sql("SELECT * FROM read_parquet('a.parquet')")\nrel.project("|")`],
  ['a connection executing SQL', `${DD}con = duckdb.connect()\nrel = con.execute("SELECT * FROM 'a.parquet'")\nrel.order("|")`],
  ['the relational reader', `${DD}duckdb.read_parquet("a.parquet").project("|")`],
  ['aggregate', `${DD}rel = duckdb.read_parquet("a.parquet")\nrel.aggregate("|")`],
  ['converted to pandas on the way', `${DD}duckdb.sql("SELECT * FROM 'a.parquet'").df().groupby("|")`]
];

for (const [name, snippet] of DUCKDB) {
  test(`duckdb: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, 'a.parquet', `failure was: ${res.failure ?? 'none'}`);
  });
}

test('duckdb read_csv_auto is a CSV', async () => {
  const res = await resolveMarked(`${DD}duckdb.read_csv_auto("a.csv").project("|")`, ROOT);
  assert.equal(res.source?.kind, 'csv');
});

/**
 * The SQL string arguments hold expressions, not one column name each. They are
 * worth completing and must never be typo-checked.
 */
test('SQL and query fragments are marked partial', async () => {
  const cases = [
    `${DD}rel = duckdb.read_parquet("a.parquet")\nrel.project("|")`,
    `${DD}rel = duckdb.read_parquet("a.parquet")\nrel.order("|")`,
    `${DD}rel = duckdb.read_parquet("a.parquet")\nrel.aggregate("|")`,
    `${PD}df.query("|")`
  ];
  for (const snippet of cases) {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, 'a.parquet');
    assert.equal(res.partial, true, snippet);
  }
});

test('a whole-name pandas site is not partial', async () => {
  const res = await resolveMarked(`${PD}df.groupby("|")`, ROOT);
  assert.equal(res.partial, undefined);
});

const NOTHING = [
  ['a rename target is a new name', `${PD}df.rename(columns={"old": "|"})`],
  ['SQL that names no file', `${DD}con = duckdb.connect()\nrel = con.execute("SELECT * FROM users")\nrel.project("|")`],
  ['a polars sql call keeps its own frame', 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\nprint("|")']
];

for (const [name, snippet] of NOTHING) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source, undefined, `unexpectedly resolved to ${res.source?.path}`);
  });
}

test('a path inside SQL is linkable', async () => {
  const res = await resolveMarked(
    `${DD}rel = duckdb.sql("SELECT * FROM 'a.parquet'")\nrel.project("|")`,
    ROOT
  );
  assert.equal(res.allSources.length, 1);
  assert.equal(res.allSources[0].path, 'a.parquet');
});

// --- reading a path out of SQL, on its own ---

test('finds a quoted data file', () => {
  const got = dataPathInSql("SELECT * FROM 'data/sales.parquet' WHERE x = 1");
  assert.equal(got.path, 'data/sales.parquet');
  assert.equal(got.kind, 'parquet');
});

test('prefers an explicit reader call over any other literal', () => {
  const got = dataPathInSql("SELECT * FROM read_csv('data/sales.csv') WHERE region = 'EU'");
  assert.equal(got.path, 'data/sales.csv');
  assert.equal(got.kind, 'csv');
});

test('the offset points at the path itself', () => {
  const sql = "SELECT * FROM 'a.parquet'";
  const got = dataPathInSql(sql);
  assert.equal(sql.slice(got.index, got.index + got.path.length), 'a.parquet');
});

test('a string that is not a file is not a file', () => {
  assert.equal(dataPathInSql("SELECT * FROM users WHERE region = 'EU'"), null);
  assert.equal(dataPathInSql('SELECT 1'), null);
  assert.equal(dataPathInSql("INSERT INTO t VALUES ('a.txt.backup')"), null);
});

test('a glob is still a path', () => {
  assert.equal(dataPathInSql("SELECT * FROM 'data/*.parquet'").path, 'data/*.parquet');
});
