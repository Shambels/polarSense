import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  readParquetSchema, readCsvSchema, readIpcSchema, readDeltaSchema, readIcebergSchema,
  readJsonSchema, readExcelSchema,
  readParquetValues, SchemaService, checkpointFiles, localStorage, resolvePath, hiveColumns,
  hiveValues, completeDataPaths, SOURCE_FUNCS
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

test('ipc: names match what polars wrote', async () => {
  // The same frame as sales.parquet, so the two readers are held to one answer.
  const columns = await readIpcSchema(localStorage, path.join(DATA, 'sales.arrow'));
  assert.deepEqual(columns.map((c) => c.name), EXPECTED.parquet.map((c) => c.name));
});

test('ipc: dtypes map onto polars display names', async () => {
  const columns = await readIpcSchema(localStorage, path.join(DATA, 'sales.arrow'));
  assert.deepEqual(Object.fromEntries(columns.map((c) => [c.name, c.dtype])), {
    region: 'str',
    revenue: 'f64',
    returns_qty: 'i32',
    units: 'i64',
    is_active: 'bool',
    order_date: 'date',
    created_at: 'datetime[\u03bcs]',
    notes: 'str',
    tags: 'list[str]'
  });
});

test('ipc: a stream reads the same as a file', async () => {
  // No ARROW1 magic and no footer — the schema message is at byte zero, which is
  // the reason this reader looks at the head rather than the end of the file.
  const stream = await readIpcSchema(localStorage, path.join(DATA, 'sales_stream.arrow'));
  const file = await readIpcSchema(localStorage, path.join(DATA, 'sales.arrow'));
  assert.deepEqual(stream, file);
});

test('ipc: a struct keeps its own fields, as deep as they go', async () => {
  const columns = await readIpcSchema(localStorage, path.join(DATA, 'arrow_types.arrow'));
  const address = columns.find((c) => c.name === 'address');
  assert.deepEqual(address.fields.map((f) => f.name), ['city', 'postcode', 'geo']);
  const geo = address.fields.find((f) => f.name === 'geo');
  assert.deepEqual(geo.fields.map((f) => f.name), ['lat', 'lon']);
  assert.equal(geo.dtype, 'struct[2]');
});

test('ipc: a list keeps no fields — its child is machinery, not a name', async () => {
  const columns = await readIpcSchema(localStorage, path.join(DATA, 'arrow_types.arrow'));
  const tags = columns.find((c) => c.name === 'tags');
  assert.equal(tags.dtype, 'list[str]');
  assert.equal(tags.fields, undefined);
});

test('ipc: the type corners polars actually writes', async () => {
  const columns = await readIpcSchema(localStorage, path.join(DATA, 'arrow_types.arrow'));
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.dtype]));
  // grade is dictionary-encoded: the encoding is what makes it a categorical
  // rather than a str. blob is a BinaryView and the strings are Utf8View —
  // the view types polars 1.x writes, which older Arrow readers never see.
  assert.equal(byName.grade, 'cat');
  assert.equal(byName.blob, 'binary');
  assert.equal(byName.price, 'decimal[18,2]');
  assert.equal(byName.opened_at, 'time');
  assert.equal(byName.elapsed, 'duration[\u03bcs]');
  assert.equal(byName.hits, 'u32');
  assert.equal(byName.ratio, 'f32');
  assert.equal(byName.point, 'array[f64, 2]');
  assert.equal(byName.utc_at, 'datetime[\u03bcs, UTC]');
});

test('ipc: a file that is not arrow reports nothing rather than guessing', async () => {
  // Every offset in a flatbuffer is read out of the bytes before it, so pointing
  // this reader at other bytes is the case where inventing columns is easy.
  assert.deepEqual(await readIpcSchema(localStorage, path.join(DATA, 'sales.parquet')), []);
  assert.deepEqual(await readIpcSchema(localStorage, path.join(DATA, 'sales.csv')), []);
});

test('ipc: a truncated file reports nothing rather than throwing', async () => {
  const truncated = path.join(os.tmpdir(), 'polarsense-truncated.arrow');
  const whole = readFileSync(path.join(DATA, 'sales.arrow'));
  writeFileSync(truncated, whole.subarray(0, 64));
  try {
    assert.deepEqual(await readIpcSchema(localStorage, truncated), []);
  } finally {
    rmSync(truncated, { force: true });
  }
});

// --- values: the one reader that reads data rather than metadata ---

const VALUES = path.join(DATA, 'values.parquet');
const VALUE_OPTS = { maxRows: 10_000, maxDistinct: 50 };

test('values: a low-cardinality column gives its values, most common first', async () => {
  // values.parquet is zstd, which is what polars writes unless told otherwise —
  // so this test is also the one that would fail if the decompressor went away.
  // 100 US, 60 EU, 40 APAC — an order that is neither alphabetical nor the
  // order they first appear in, so the sort is doing something.
  const found = await readParquetValues(localStorage, VALUES, 'region', VALUE_OPTS);
  assert.deepEqual(found.values, ['US', 'EU', 'APAC']);
  assert.equal(found.complete, true, '200 rows of 200 read is the whole column');
});

test('values: past the cap the answer is nothing, not a truncated list', async () => {
  // order_id has 200 distinct values. Half a list of ids is worse than no list:
  // it reads as "these are the values" when it is "these are some of them".
  const found = await readParquetValues(localStorage, VALUES, 'order_id', VALUE_OPTS);
  assert.equal(found, null);
});

test('values: the cap is a limit on distinct values, not on rows', async () => {
  const found = await readParquetValues(
    localStorage, VALUES, 'region', { ...VALUE_OPTS, maxDistinct: 3 }
  );
  assert.equal(found.values.length, 3, 'exactly at the cap is still an answer');
  assert.equal(
    await readParquetValues(localStorage, VALUES, 'region', { ...VALUE_OPTS, maxDistinct: 2 }),
    null
  );
});

test('values: a partial read says so', async () => {
  // The first ten rows are all APAC, which is exactly the point — a head sample
  // of a sorted column is not the column, and `complete` is how anyone knows.
  const found = await readParquetValues(localStorage, VALUES, 'region', {
    ...VALUE_OPTS, maxRows: 10
  });
  assert.deepEqual(found.values, ['APAC']);
  assert.equal(found.complete, false);
});

test('values: a column that is not strings gives nothing', async () => {
  // What gets inserted goes inside quotes, so a float would be the wrong literal.
  assert.equal(await readParquetValues(localStorage, VALUES, 'revenue', VALUE_OPTS), null);
});

test('values: a column of nulls gives nothing rather than an empty list', async () => {
  assert.equal(await readParquetValues(localStorage, VALUES, 'empty', VALUE_OPTS), null);
});

test('values: a column that is not there gives nothing rather than throwing', async () => {
  assert.equal(await readParquetValues(localStorage, VALUES, 'nope', VALUE_OPTS), null);
});

test('hive values: the directory names are the whole domain', async () => {
  // No data is read at all here — the partitioning *is* the list of values, so
  // unlike a parquet read this can never be a sample.
  const found = await hiveValues(path.join(DATA, 'hive'), 'region', 50);
  assert.deepEqual(found, ['EU', 'US']);
});

test('hive values: a column that partitions nothing gives nothing', async () => {
  assert.equal(await hiveValues(path.join(DATA, 'hive'), 'revenue', 50), null);
});

test('hive values: too many partitions is a silence too', async () => {
  assert.equal(await hiveValues(path.join(DATA, 'hive'), 'region', 1), null);
});

test('paths: a hive directory remembers the root its partitions came from', async () => {
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
  const resolved = await resolvePath({ kind: 'parquet', path: 'hive', kwargs: {} }, ctx);
  assert.equal(resolved.hiveRoot, path.join(DATA, 'hive'));
  const plain = await resolvePath({ kind: 'parquet', path: 'sales.parquet', kwargs: {} }, ctx);
  assert.equal(plain.hiveRoot, undefined);
});


// --- the service around the value reader: the gate, and reading once ---

function valueService(over = {}) {
  return new SchemaService({
    cacheSize: 10, maxColumns: 5000, httpsEnabled: false,
    csvSniffBytes: 262144, csvInferDtypes: false,
    valuesEnabled: true, valueMaxRows: 10_000, valueMaxDistinct: 50, ...over
  });
}

const VALUE_CTX = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };
const VALUE_SOURCE = { kind: 'parquet', path: 'values.parquet', kwargs: {} };

test('service: with the setting off, nothing reads the data at all', async () => {
  const service = valueService({ valuesEnabled: false });
  assert.equal(await service.values(VALUE_SOURCE, VALUE_CTX, 'region'), null);
});

test('service: concurrent asks for one column share a single read', async () => {
  // Typing inside the string re-asks per keystroke. Identical results by
  // identity is the proof that only one read produced them.
  const service = valueService();
  const [a, b, c] = await Promise.all([
    service.values(VALUE_SOURCE, VALUE_CTX, 'region'),
    service.values(VALUE_SOURCE, VALUE_CTX, 'region'),
    service.values(VALUE_SOURCE, VALUE_CTX, 'region')
  ]);
  assert.deepEqual(a.values, ['US', 'EU', 'APAC']);
  assert.equal(a, b);
  assert.equal(b, c);
  // And the answer is remembered, so a later ask is the same object again.
  assert.equal(await service.values(VALUE_SOURCE, VALUE_CTX, 'region'), a);
});

test('service: "there is no answer" is remembered too', async () => {
  const service = valueService();
  assert.equal(await service.values(VALUE_SOURCE, VALUE_CTX, 'order_id'), null);
  assert.equal(await service.values(VALUE_SOURCE, VALUE_CTX, 'order_id'), null);
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

test('delta: falls back to the checkpoint when the commits are vacuumed', async () => {
  // Only a checkpoint parquet and one later add-only commit. The JSON walk finds
  // no metaData, and the schema is read out of the checkpoint instead.
  const columns = await readDeltaSchema(localStorage, path.join(DATA, 'delta_checkpoint'));
  assert.deepEqual(
    columns.map((c) => [c.name, c.dtype]),
    [
      ['region', 'str'],
      ['revenue', 'f64'],
      ['checkpointed_at', 'datetime[\u03bcs, UTC]']
    ]
  );
});

test('delta: a JSON commit still wins over the checkpoint below it', async () => {
  // delta_sales has both a metaData commit and no checkpoint; the walk answers
  // first, which is the ordering that keeps a stale checkpoint from surfacing.
  const columns = await readDeltaSchema(localStorage, path.join(DATA, 'delta_sales'));
  assert.equal(columns[0].name, 'region');
  assert.equal(columns.length, 6);
});

test('delta: the newest checkpoint version wins, and its parts read in order', () => {
  const got = checkpointFiles([
    '_last_checkpoint',
    '00000000000000000010.json',
    '00000000000000000010.checkpoint.parquet',
    '00000000000000000020.checkpoint.0000000002.0000000002.parquet',
    '00000000000000000020.checkpoint.0000000001.0000000002.parquet'
  ]);
  assert.deepEqual(got, [
    '00000000000000000020.checkpoint.0000000001.0000000002.parquet',
    '00000000000000000020.checkpoint.0000000002.0000000002.parquet'
  ]);
});

test('delta: nothing that only looks like a checkpoint is read', () => {
  assert.deepEqual(checkpointFiles([]), []);
  assert.deepEqual(checkpointFiles(['00000000000000000010.json']), []);
  assert.deepEqual(checkpointFiles(['00000000000000000010.checkpointX.parquet']), []);
  // A v2 checkpoint's JSON sibling is not a parquet file.
  assert.deepEqual(
    checkpointFiles(['00000000000000000010.checkpoint.abc-def.json']),
    []
  );
});

test('delta: a zstd checkpoint reads, which it did not before fzstd', async () => {
  // Reading a checkpoint is one of the two places a parquet *page* is
  // decompressed rather than a footer read. polars and modern delta-rs write
  // zstd by default, and this used to be the case that reported nothing.
  const columns = await readDeltaSchema(localStorage, path.join(DATA, 'delta_checkpoint_zstd'));
  assert.deepEqual(columns.map((c) => c.name), ['region', 'zstd_only']);
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


// ---- NDJSON, JSON and Excel ----------------------------------------------

const SNIFF = 262144;

test('ndjson: dtypes come from the values, not from a string match', async () => {
  const columns = await readJsonSchema(path.join(DATA, 'sales.ndjson'), SNIFF);
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.dtype]));
  assert.equal(byName.region, 'str');
  assert.equal(byName.revenue, 'f64');
  assert.equal(byName.units, 'i64');
  assert.equal(byName.is_active, 'bool');
  assert.equal(byName.tags, 'list[str]');
});

test('ndjson: a key that is null in every row gets a blank dtype, not a guess', async () => {
  const columns = await readJsonSchema(path.join(DATA, 'sales.ndjson'), SNIFF);
  assert.equal(columns.find((c) => c.name === 'notes').dtype, '');
});

test('ndjson: a key absent from the first row is still a column', async () => {
  const columns = await readJsonSchema(path.join(DATA, 'sales.ndjson'), SNIFF);
  assert.ok(columns.some((c) => c.name === 'late_key'));
  // ...and the keys that were there keep their original order.
  assert.equal(columns[0].name, 'region');
});

test('ndjson: an int column widens to f64 when a later row is fractional', async () => {
  const columns = await readJsonSchema(path.join(DATA, 'sales.ndjson'), SNIFF);
  assert.equal(columns.find((c) => c.name === 'mixed').dtype, 'f64');
});

test('json: an array of objects reads the same as newline-delimited', async () => {
  const array = await readJsonSchema(path.join(DATA, 'sales.json'), SNIFF);
  const lines = await readJsonSchema(path.join(DATA, 'sales.ndjson'), SNIFF);
  assert.deepEqual(array.map((c) => c.name), lines.map((c) => c.name));
});

test('json: a nested object keeps its own fields', async () => {
  const columns = await readJsonSchema(path.join(DATA, 'nested.ndjson'), SNIFF);
  const address = columns.find((c) => c.name === 'address');
  assert.equal(address.dtype, 'struct[2]');
  assert.deepEqual(address.fields.map((f) => f.name), ['city', 'geo']);
  assert.deepEqual(
    address.fields.find((f) => f.name === 'geo').fields.map((f) => f.name),
    ['lat', 'lon']
  );
  assert.equal(columns.find((c) => c.name === 'scores').dtype, 'list[i64]');
});

test('json: a brace inside a string does not end the object', async () => {
  const file = path.join(os.tmpdir(), `polarsense-brace-${process.pid}.ndjson`);
  writeFileSync(file, '{"note": "a } and a { in here", "n": 1}\n');
  try {
    const columns = await readJsonSchema(file, SNIFF);
    assert.deepEqual(columns.map((c) => c.name), ['note', 'n']);
  } finally {
    rmSync(file, { force: true });
  }
});

test('json: an object the prefix read cut in half is dropped, not fatal', async () => {
  const file = path.join(os.tmpdir(), `polarsense-cut-${process.pid}.ndjson`);
  writeFileSync(file, '{"a": 1, "b": 2}\n{"a": 3, "c": ');
  try {
    const columns = await readJsonSchema(file, SNIFF);
    assert.deepEqual(columns.map((c) => c.name), ['a', 'b']);
  } finally {
    rmSync(file, { force: true });
  }
});

test('json: a file with no objects in it reports nothing', async () => {
  const file = path.join(os.tmpdir(), `polarsense-scalars-${process.pid}.json`);
  writeFileSync(file, '[1, 2, 3]');
  try {
    assert.deepEqual(await readJsonSchema(file, SNIFF), []);
  } finally {
    rmSync(file, { force: true });
  }
});

test('excel: the header row is the schema, through the shared string table', async () => {
  const columns = await readExcelSchema(localStorage, path.join(DATA, 'sales.xlsx'));
  assert.equal(columns[0].name, 'region');
  assert.equal(columns[1].name, 'revenue');
});

test('excel: a skipped cell is named rather than closed up', async () => {
  const columns = await readExcelSchema(localStorage, path.join(DATA, 'sales.xlsx'));
  // A1, B1, then D1 — so C is a hole, and "Q1 & Q2" must stay in fourth place.
  assert.equal(columns.length, 4);
  assert.equal(columns[2].name, 'column_3');
  assert.equal(columns[3].name, 'Q1 & Q2');
});

test('excel: a file that is not a zip reports nothing rather than throwing', async () => {
  const file = path.join(os.tmpdir(), `polarsense-notzip-${process.pid}.xlsx`);
  writeFileSync(file, 'this is not a spreadsheet');
  try {
    assert.deepEqual(await readExcelSchema(localStorage, file), []);
  } finally {
    rmSync(file, { force: true });
  }
});

test('service: the new kinds are wired all the way through', async () => {
  // The readers above are called directly; this is the proof that the switch in
  // SchemaService, and the extension table that produces the kind, agree.
  const service = valueService();
  const ctx = { documentDir: DATA, workspaceDirs: [], extraRoots: [] };

  const json = await service.get({ kind: 'json', path: 'sales.ndjson', kwargs: {} }, ctx);
  assert.equal(json.error, undefined);
  assert.equal(json.schema.columns[0].name, 'region');

  const excel = await service.get({ kind: 'excel', path: 'sales.xlsx', kwargs: {} }, ctx);
  assert.equal(excel.error, undefined);
  assert.equal(excel.schema.columns[0].name, 'region');
});

test('service: read_json and read_excel resolve to the right kind', async () => {
  // SOURCE_FUNCS is what turns the call at the cursor into a kind, so a name
  // missing from it means the reader above is never reached.
  assert.equal(SOURCE_FUNCS.read_json, 'json');
  assert.equal(SOURCE_FUNCS.scan_ndjson, 'json');
  assert.equal(SOURCE_FUNCS.read_ndjson, 'json');
  assert.equal(SOURCE_FUNCS.read_excel, 'excel');
});
