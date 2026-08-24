import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readParquetSchema, readCsvSchema, readDeltaSchema, readIcebergSchema,
  localStorage, resolvePath, hiveColumns, completeDataPaths
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'expected.json'), 'utf8'));

const CSV_OPTS = { sniffBytes: 262144, inferDtypes: false };

test('parquet: names match what polars wrote', async () => {
  const columns = (await readParquetSchema(localStorage, path.join(DATA, 'sales.parquet'))).columns;
  assert.deepEqual(
    columns.map((c) => c.name),
    EXPECTED.parquet.map((c) => c.name)
  );
});

test('parquet: dtypes map onto polars display names', async () => {
  const columns = (await readParquetSchema(localStorage, path.join(DATA, 'sales.parquet'))).columns;
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.dtype]));
  assert.deepEqual(byName, {
    region: 'str',
    revenue: 'f64',
    returns_qty: 'i32',
    units: 'i64',
    is_active: 'bool',
    order_date: 'date',
    created_at: 'datetime[μs]',
    notes: 'str',
    tags: 'list[str]'
  });
});

test('csv: header row is the schema', async () => {
  const columns = await readCsvSchema(path.join(DATA, 'sales.csv'), {}, CSV_OPTS);
  assert.deepEqual(columns.map((c) => c.name), EXPECTED.csv);
});

test('csv: honours separator=', async () => {
  const columns = await readCsvSchema(
    path.join(DATA, 'sales_semi.csv'), { separator: ';' }, CSV_OPTS
  );
  assert.deepEqual(columns.map((c) => c.name), EXPECTED.csv);
});

test('csv: the wrong separator yields one fused column, not a crash', async () => {
  const columns = await readCsvSchema(path.join(DATA, 'sales_semi.csv'), {}, CSV_OPTS);
  assert.equal(columns.length, 1);
});

test('csv: has_header=False yields polars-style generated names', async () => {
  const columns = await readCsvSchema(
    path.join(DATA, 'headerless.csv'), { has_header: false }, CSV_OPTS
  );
  assert.deepEqual(columns.map((c) => c.name), ['column_1', 'column_2', 'column_3']);
});

test('csv: comment_prefix= skips the preamble', async () => {
  const columns = await readCsvSchema(
    path.join(DATA, 'commented.csv'), { comment_prefix: '#' }, CSV_OPTS
  );
  assert.deepEqual(columns.map((c) => c.name), ['region', 'revenue']);
});

test('csv: a separator inside quotes does not split a field', async () => {
  const columns = await readCsvSchema(path.join(DATA, 'quoted.csv'), {}, CSV_OPTS);
  assert.deepEqual(columns.map((c) => c.name), ['region, long name', 'revenue']);
});

test('csv: skip_rows= starts lower down', async () => {
  const columns = await readCsvSchema(
    path.join(DATA, 'commented.csv'), { skip_rows: 2 }, CSV_OPTS
  );
  assert.deepEqual(columns.map((c) => c.name), ['region', 'revenue']);
});

test('csv: dtype inference stays off unless asked', async () => {
  const off = await readCsvSchema(path.join(DATA, 'sales.csv'), {}, CSV_OPTS);
  assert.ok(off.every((c) => c.dtype === ''));
  const on = await readCsvSchema(
    path.join(DATA, 'sales.csv'), {}, { ...CSV_OPTS, inferDtypes: true }
  );
  const byName = Object.fromEntries(on.map((c) => [c.name, c.dtype]));
  assert.equal(byName.revenue, 'f64');
  assert.equal(byName.units, 'i64');
  assert.equal(byName.region, 'str');
  assert.equal(byName.order_date, 'date');
});

test('delta: walks the log backwards to the newest metaData', async () => {
  const columns = await readDeltaSchema(localStorage, path.join(DATA, 'delta_sales'));
  assert.deepEqual(
    columns.map((c) => [c.name, c.dtype]),
    [
      ['region', 'str'],
      ['revenue', 'f64'],
      ['units', 'i64'],
      ['opened_at', 'datetime[μs, UTC]'],
      ['price', 'decimal[18,2]'],
      ['tags', 'list[str]']
    ]
  );
});

test('delta: a directory that is not a table reports nothing', async () => {
  const columns = await readDeltaSchema(localStorage, path.join(DATA, 'hive'));
  assert.deepEqual(columns, []);
});

test('iceberg: version-hint picks the current schema, not the first', async () => {
  const columns = await readIcebergSchema(localStorage, path.join(DATA, 'iceberg_sales'));
  assert.deepEqual(
    columns.map((c) => [c.name, c.dtype]),
    [
      ['region', 'str'],
      ['revenue', 'f64'],
      ['units', 'i64'],
      ['opened_at', 'datetime[μs, UTC]'],
      ['price', 'decimal[18,2]'],
      ['tags', 'list[str]']
    ]
  );
});

test('paths: relative to the document, then the workspace', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [ROOT], extraRoots: [] };
  const viaDocument = await resolvePath({ kind: 'parquet', path: 'sales.parquet', kwargs: {} }, ctx);
  assert.equal(viaDocument?.uri, path.join(DATA, 'sales.parquet'));

  const viaWorkspace = await resolvePath(
    { kind: 'parquet', path: 'test/fixtures/data/sales.parquet', kwargs: {} },
    { documentDir: '/nowhere', workspaceDirs: [ROOT], extraRoots: [] }
  );
  assert.equal(viaWorkspace?.uri, path.join(DATA, 'sales.parquet'));
});

test('paths: a glob resolves to a real file', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const resolved = await resolvePath({ kind: 'parquet', path: '*.parquet', kwargs: {} }, ctx);
  assert.equal(resolved?.uri, path.join(DATA, 'sales.parquet'));
});

test('paths: a hive directory contributes its partition column', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const resolved = await resolvePath({ kind: 'parquet', path: 'hive', kwargs: {} }, ctx);
  assert.ok(resolved);
  assert.deepEqual(resolved.hivePartitions.map((c) => c.name), ['region']);
});

test('paths: a missing file resolves to nothing rather than throwing', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  assert.equal(await resolvePath({ kind: 'parquet', path: 'nope.parquet', kwargs: {} }, ctx), null);
});

test('hive columns are read off the directory names', () => {
  const columns = hiveColumns('/data', '/data/region=EU/year=2026/part-0.parquet');
  assert.deepEqual(columns.map((c) => c.name), ['region', 'year']);
});

test('csv: new_columns= overrides the header row', async () => {
  const columns = await readCsvSchema(
    path.join(DATA, 'sales.csv'), { new_columns: ['alpha', 'beta', 'gamma'] }, CSV_OPTS
  );
  assert.deepEqual(columns.map((c) => c.name), ['alpha', 'beta', 'gamma']);
});

test('path completion: offers data files and folders, not everything', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const found = await completeDataPaths('', 'parquet', ctx);
  const names = found.map((c) => c.name);
  assert.ok(names.includes('sales.parquet'), 'parquet file missing');
  assert.ok(names.includes('hive'), 'directory missing');
  assert.ok(!names.includes('sales.csv'), 'a csv should not be offered to a parquet reader');
});

test('path completion: a csv reader sees csv files', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const names = (await completeDataPaths('', 'csv', ctx)).map((c) => c.name);
  assert.ok(names.includes('sales.csv'));
  assert.ok(!names.includes('sales.parquet'));
});

test('path completion: a delta reader offers only table directories', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const found = await completeDataPaths('', 'delta', ctx);
  assert.ok(found.every((c) => c.isDir), 'files should not be offered for a table reader');
  const delta = found.find((c) => c.name === 'delta_sales');
  assert.ok(delta?.isTable, 'delta_sales should be marked as a table');
  assert.ok(!found.some((c) => c.name === 'hive'), 'a plain directory is not a delta table');
});

test('path completion: descends into a typed directory prefix', async () => {
  const ctx = { documentDir: ROOT, workspaceDirs: [], extraRoots: [] };
  const names = (await completeDataPaths('test/fixtures/data/', 'parquet', ctx)).map((c) => c.name);
  assert.ok(names.includes('sales.parquet'));
});

test('path completion: skips dotfiles and dependency directories', async () => {
  const ctx = { documentDir: ROOT, workspaceDirs: [], extraRoots: [] };
  const names = (await completeDataPaths('', 'parquet', ctx)).map((c) => c.name);
  assert.ok(!names.includes('node_modules'));
  assert.ok(!names.some((n) => n.startsWith('.')));
});

test('parquet: statistics come off the same footer as the schema', async () => {
  const { columns, rowCount } = await readParquetSchema(
    localStorage, path.join(DATA, 'sales.parquet')
  );
  assert.equal(rowCount, 3);
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.stats]));

  assert.deepEqual(byName.region, { nullCount: 0, min: 'APAC', max: 'US' });
  assert.deepEqual(byName.revenue, { nullCount: 0, min: '1.5', max: '3' });
  assert.equal(byName.notes.nullCount, 1, 'the null in notes should be counted');
});

test('parquet: date and datetime statistics are formatted, not raw integers', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'sales.parquet'));
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.stats]));
  assert.equal(byName.order_date.min, '2026-01-01');
  assert.equal(byName.order_date.max, '2026-03-01');
  assert.ok(byName.created_at.min.startsWith('2026-01-01 12:00'), byName.created_at.min);
});

test('parquet: int64 statistics survive the BigInt round trip', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'sales.parquet'));
  const units = columns.find((c) => c.name === 'units');
  assert.equal(units.stats.min, '10');
  assert.equal(units.stats.max, '30');
});

test('csv columns carry no statistics — the format has none to give', async () => {
  const columns = await readCsvSchema(path.join(DATA, 'sales.csv'), {}, CSV_OPTS);
  assert.ok(columns.every((c) => c.stats === undefined));
});
