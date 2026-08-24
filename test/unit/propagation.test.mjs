import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initParser, parse, buildBindingTable, resolveAtOffset, evaluateFrame, exprNames, nearest
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\n';
const SOURCE_COLUMNS = ['a', 'b', 'c'].map((name) => ({ name, dtype: 'i64' }));

/** Evaluate the frame at the cursor against a fixed three-column source. */
async function columnsAt(marked, columns = SOURCE_COLUMNS) {
  const offset = marked.indexOf('|');
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const parser = await initParser(ROOT);
  const tree = parse(parser, source);
  const table = buildBindingTable(tree);
  const res = resolveAtOffset(tree, table, offset);
  if (!res.frame) return null;
  const evaluated = evaluateFrame(res.frame, () => columns, table);
  return evaluated && { names: evaluated.columns.map((c) => c.name), certain: evaluated.certain };
}

const CASES = [
  ['plain source', `${HEAD}df.select("|")`, ['a', 'b', 'c'], true],
  ['select', `${HEAD}n = df.select("a", "b")\nn.select("|")`, ['a', 'b'], true],
  ['select with a list', `${HEAD}n = df.select(["a"])\nn.select("|")`, ['a'], true],
  ['drop', `${HEAD}n = df.drop("b")\nn.select("|")`, ['a', 'c'], true],
  ['rename', `${HEAD}n = df.rename({"a": "z"})\nn.select("|")`, ['z', 'b', 'c'], true],
  ['with_columns alias', `${HEAD}n = df.with_columns(pl.col("a").sum().alias("t"))\nn.select("|")`, ['a', 'b', 'c', 't'], true],
  ['with_columns replaces in place', `${HEAD}n = df.with_columns(pl.col("a") * 2)\nn.select("|")`, ['a', 'b', 'c'], true],
  ['with_row_index', `${HEAD}n = df.with_row_index("i")\nn.select("|")`, ['i', 'a', 'b', 'c'], true],
  ['group_by + agg', `${HEAD}n = df.group_by("a").agg(pl.col("b").sum())\nn.select("|")`, ['a', 'b'], true],
  ['identity methods', `${HEAD}n = df.filter(x).sort("a").head(3)\nn.select("|")`, ['a', 'b', 'c'], true],
  ['long chain', `${HEAD}n = df.select("a", "b").rename({"b": "z"}).drop("a")\nn.select("|")`, ['z'], true],
  ['pl.all', `${HEAD}n = df.select(pl.all())\nn.select("|")`, ['a', 'b', 'c'], true],
  ['pl.exclude', `${HEAD}n = df.select(pl.exclude("b"))\nn.select("|")`, ['a', 'c'], true],
  ['name suffix', `${HEAD}n = df.select(pl.col("a").name.suffix("_x"))\nn.select("|")`, ['a_x'], true],
  ['keyword names its column', `${HEAD}n = df.with_columns(t=pl.col("a"))\nn.select("|")`, ['a', 'b', 'c', 't'], true]
];

for (const [name, snippet, expected, certain] of CASES) {
  test(`propagates: ${name}`, async () => {
    const got = await columnsAt(snippet);
    assert.ok(got, 'no frame resolved');
    assert.deepEqual(got.names, expected);
    assert.equal(got.certain, certain);
  });
}

/** When a step cannot be modelled, keep the columns but stop claiming certainty. */
const UNCERTAIN = [
  ['a reshape we do not model', `${HEAD}n = df.unpivot()\nn.select("|")`],
  ['a selector', `${HEAD}n = df.select(cs.numeric())\nn.select("|")`],
  ['a regex column pattern', `${HEAD}n = df.select("^a.*$")\nn.select("|")`],
  ['a rename with a computed key', `${HEAD}n = df.rename({key: "z"})\nn.select("|")`],
  ['an unknown helper method', `${HEAD}n = df.my_helper()\nn.select("|")`]
];

for (const [name, snippet] of UNCERTAIN) {
  test(`admits uncertainty: ${name}`, async () => {
    const got = await columnsAt(snippet);
    assert.ok(got, 'no frame resolved');
    assert.equal(got.certain, false, 'should not claim certainty');
    assert.ok(got.names.length >= 3, 'should keep offering what it had');
  });
}

test('narrowing never loses a column that survived', async () => {
  // A select of a column the source does not have still offers it: polars would
  // error, and inventing a shorter list would hide the user's typo.
  const got = await columnsAt(`${HEAD}n = df.select("a", "nope")\nn.select("|")`);
  assert.deepEqual(got.names, ['a', 'nope']);
});

test('expression names: the shapes that matter', async () => {
  const parser = await initParser(ROOT);
  const ctx = { polarsAliases: new Set(['pl']), bareExprFuncs: new Set() };
  const nameOf = (expr) => {
    const tree = parse(parser, `x = ${expr}\n`);
    const rhs = tree.rootNode.descendantsOfType('assignment')[0].childForFieldName('right');
    return exprNames(rhs, ctx);
  };
  assert.deepEqual(nameOf('"a"'), { kind: 'names', names: ['a'] });
  assert.deepEqual(nameOf('pl.col("a")'), { kind: 'names', names: ['a'] });
  assert.deepEqual(nameOf('pl.col("a", "b")'), { kind: 'names', names: ['a', 'b'] });
  assert.deepEqual(nameOf('pl.col("a").sum()'), { kind: 'names', names: ['a'] });
  assert.deepEqual(nameOf('pl.col("a").sum().alias("t")'), { kind: 'names', names: ['t'] });
  assert.deepEqual(nameOf('pl.col("a") + pl.col("b")'), { kind: 'names', names: ['a'] });
  assert.deepEqual(nameOf('pl.lit(1).alias("k")'), { kind: 'names', names: ['k'] });
  assert.deepEqual(nameOf('pl.all()'), { kind: 'all' });
  assert.deepEqual(nameOf('pl.exclude("a")'), { kind: 'except', names: ['a'] });
  assert.equal(nameOf('cs.numeric()').kind, 'unknown');
  assert.equal(nameOf('"^regex$"').kind, 'unknown');
});

// --- the "did you mean" suggestion behind the diagnostic quick fix ---

const COLUMNS = ['region', 'revenue', 'returns_qty', 'units', 'is_active', 'order_date'];

test('suggests the obvious near-misses', () => {
  assert.deepEqual(nearest('regoin', COLUMNS), ['region']);      // transposition
  assert.deepEqual(nearest('regin', COLUMNS), ['region']);       // omission
  assert.deepEqual(nearest('regionn', COLUMNS), ['region']);     // doubled letter
  assert.deepEqual(nearest('Region', COLUMNS), ['region']);      // case only
  assert.deepEqual(nearest('REGION', COLUMNS), ['region']);
});

test('offers nothing when nothing is close', () => {
  assert.deepEqual(nearest('completely_different', COLUMNS), []);
  assert.deepEqual(nearest('x', COLUMNS), []);
});

test('a short name does not match another short name loosely', () => {
  // "id" and "at" are one edit apart but mean different things; the threshold
  // scales with length so short names have to be nearly right.
  assert.deepEqual(nearest('id', ['at', 'of']), []);
});

test('closer candidates come first, and the list is capped', () => {
  const got = nearest('revenu', ['revenue', 'revenues', 'revenue_net', 'region']);
  assert.equal(got[0], 'revenue');
  assert.ok(got.length <= 3);
});

test('an exact match suggests nothing — it is not a typo', () => {
  assert.deepEqual(nearest('region', COLUMNS), []);
});
