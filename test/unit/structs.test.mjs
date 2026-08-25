import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readParquetSchema, parseDeltaSchemaString, parseIcebergMetadata, localStorage,
  resolveMarked, analyzeSource, resolveAtOffset, structFields, exprNames, initParser, parse
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');
const PL = 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\n';

// --- the readers keep the tree ---

test('parquet: a struct column carries its own fields', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'structs.parquet'));
  const address = columns.find((c) => c.name === 'address');
  assert.deepEqual(address.fields.map((f) => [f.name, f.dtype]), [
    ['city', 'str'],
    ['postcode', 'str'],
    ['geo', 'struct[2]']
  ]);
});

test('parquet: a struct inside a struct keeps going', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'structs.parquet'));
  const geo = columns.find((c) => c.name === 'address').fields.find((f) => f.name === 'geo');
  assert.deepEqual(geo.fields.map((f) => f.name), ['lat', 'lon']);
});

test('parquet: a list is a group, but its machinery is not a field', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'structs.parquet'));
  const tags = columns.find((c) => c.name === 'tags');
  assert.equal(tags.dtype, 'list[str]');
  assert.equal(tags.fields, undefined, 'list.element is not a field anyone can name');
});

test('parquet: a struct field finds its own statistics', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'structs.parquet'));
  const city = columns.find((c) => c.name === 'address').fields.find((f) => f.name === 'city');
  assert.equal(city.stats.min, 'Ghent');
  assert.equal(city.stats.max, 'Lisbon');
});

test('parquet: a flat schema is unchanged by all this', async () => {
  const { columns } = await readParquetSchema(localStorage, path.join(DATA, 'sales.parquet'));
  assert.ok(columns.every((c) => c.fields === undefined || c.dtype.startsWith('struct')));
  const region = columns.find((c) => c.name === 'region');
  assert.equal(region.stats.min, 'APAC');
});

test('delta: a nested struct comes through the schemaString', () => {
  const columns = parseDeltaSchemaString(JSON.stringify({
    type: 'struct',
    fields: [
      { name: 'id', type: 'long', nullable: true, metadata: {} },
      {
        name: 'address',
        type: {
          type: 'struct',
          fields: [
            { name: 'city', type: 'string', nullable: true, metadata: {} },
            { name: 'postcode', type: 'string', nullable: true, metadata: {} }
          ]
        },
        nullable: true,
        metadata: {}
      }
    ]
  }));
  assert.deepEqual(columns.map((c) => c.name), ['id', 'address']);
  assert.deepEqual(columns[1].fields.map((f) => [f.name, f.dtype]), [
    ['city', 'str'],
    ['postcode', 'str']
  ]);
});

test('iceberg: a nested struct comes through the metadata', () => {
  const columns = parseIcebergMetadata(JSON.stringify({
    'current-schema-id': 0,
    schemas: [{
      'schema-id': 0,
      fields: [
        { id: 1, name: 'id', type: 'long' },
        {
          id: 2,
          name: 'address',
          type: { type: 'struct', fields: [{ id: 3, name: 'city', type: 'string' }] }
        }
      ]
    }]
  }));
  assert.deepEqual(columns[1].fields.map((f) => [f.name, f.dtype]), [['city', 'str']]);
});

// --- walking a path into it ---

const COLUMNS = [
  { name: 'id', dtype: 'i64' },
  {
    name: 'address',
    dtype: 'struct[2]',
    fields: [
      { name: 'city', dtype: 'str' },
      { name: 'geo', dtype: 'struct[1]', fields: [{ name: 'lat', dtype: 'f64' }] }
    ]
  }
];

test('a path into a struct returns its fields', () => {
  assert.deepEqual(structFields(COLUMNS, ['address']).map((f) => f.name), ['city', 'geo']);
  assert.deepEqual(structFields(COLUMNS, ['address', 'geo']).map((f) => f.name), ['lat']);
});

test('a path that leads nowhere says so, rather than saying nothing exists', () => {
  assert.equal(structFields(COLUMNS, ['nope']), null);
  assert.equal(structFields(COLUMNS, ['id']), null, 'not a struct');
  assert.equal(structFields(COLUMNS, ['address', 'city']), null, 'not a struct either');
});

// --- the completion site ---

const CASES = [
  ['a struct field', `${PL}df.select(pl.col("address").struct.field("|"))`, ['address']],
  ['part-typed', `${PL}df.select(pl.col("address").struct.field("cit|"))`, ['address']],
  ['nested twice', `${PL}df.select(pl.col("address").struct.field("geo").struct.field("|"))`,
    ['address', 'geo']],
  ['in with_columns', `${PL}df.with_columns(pl.col("address").struct.field("|"))`, ['address']],
  ['aliased afterwards', `${PL}df.select(pl.col("address").struct.field("|").alias("c"))`,
    ['address']],
  ['a bare column string', `${PL}df.select(pl.col("a", "b"))`, null]
];

for (const [name, snippet, expected] of CASES) {
  if (!expected) continue;
  test(`struct site: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, 'a.parquet', `failure was: ${res.failure ?? 'none'}`);
    assert.deepEqual(res.structPath, expected);
  });
}

test('an ordinary column site has no struct path', async () => {
  const res = await resolveMarked(`${PL}df.select(pl.col("|"))`, ROOT);
  assert.equal(res.source?.path, 'a.parquet');
  assert.equal(res.structPath, undefined);
});

const NOTHING = [
  ['a computed field name', `${PL}df.select(pl.col("address").struct.field(name).struct.field("|"))`],
  ['field on something that is not a struct namespace', `${PL}df.select(pl.col("a").field("|"))`],
  ['outside any frame method', `${PL}x = pl.col("address").struct.field("|")`]
];

for (const [name, snippet] of NOTHING) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, undefined, 'unexpectedly resolved');
  });
}

test('the field, not the struct, is what the expression is called', async () => {
  const parser = await initParser(ROOT);
  const ctx = {
    polarsAliases: new Set(['pl']),
    bareExprFuncs: new Set(),
    selectorAliases: new Set(),
    bareSelectorFuncs: new Set()
  };
  const tree = parse(parser, 'x = pl.col("address").struct.field("city")\n');
  const rhs = tree.rootNode.descendantsOfType('assignment')[0].childForFieldName('right');
  assert.deepEqual(exprNames(rhs, ctx), { kind: 'names', names: ['city'] });
});

test('a struct field propagates as a column of its own name', async () => {
  const source = `${PL}n = df.select(pl.col("address").struct.field("city"))\nn.select("")`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.lastIndexOf('""') + 1);
  assert.ok(res.frame, 'no frame resolved');
  const { evaluateFrame } = await import('../harness.mjs');
  const columns = [{ name: 'address', dtype: 'struct[1]' }, { name: 'id', dtype: 'i64' }];
  const evaluated = evaluateFrame(res.frame, () => columns, table);
  assert.deepEqual(evaluated.columns.map((c) => c.name), ['city']);
});

test('unnest names a top-level struct column', async () => {
  const res = await resolveMarked(`${PL}df.unnest("addr|")`, ROOT);
  assert.equal(res.source?.path, 'a.parquet');
  assert.equal(res.structPath, undefined);
});
