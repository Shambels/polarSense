import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initParser, parse, buildBindingTable, resolveAtOffset, evaluateFrame, exprNames, nearest
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\n';
const CS = 'import polars as pl\nimport polars.selectors as cs\ndf = pl.scan_parquet("a.parquet")\n';
const SOURCE_COLUMNS = ['a', 'b', 'c'].map((name) => ({ name, dtype: 'i64' }));
/** A mixed-dtype source, for the selectors that pick by type rather than name. */
const TYPED_COLUMNS = [
  { name: 'region', dtype: 'str' },
  { name: 'revenue', dtype: 'f64' },
  { name: 'units', dtype: 'i64' },
  { name: 'order_date', dtype: 'date' }
];

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
  ['keyword names its column', `${HEAD}n = df.with_columns(t=pl.col("a"))\nn.select("|")`, ['a', 'b', 'c', 't'], true],
  ['cs.by_name', `${CS}n = df.select(cs.by_name("a", "c"))\nn.select("|")`, ['a', 'c'], true],
  ['cs.by_name with a list', `${CS}n = df.select(cs.by_name(["b"]))\nn.select("|")`, ['b'], true],
  ['cs.exclude', `${CS}n = df.select(cs.exclude("b"))\nn.select("|")`, ['a', 'c'], true],
  ['cs.all', `${CS}n = df.select(cs.all())\nn.select("|")`, ['a', 'b', 'c'], true],
  ['a bare selector import', `import polars as pl\nfrom polars.selectors import by_name\ndf = pl.scan_parquet("a.parquet")\nn = df.select(by_name("a"))\nn.select("|")`, ['a'], true]
];

for (const [name, snippet, expected, certain] of CASES) {
  test(`propagates: ${name}`, async () => {
    const got = await columnsAt(snippet);
    assert.ok(got, 'no frame resolved');
    assert.deepEqual(got.names, expected);
    assert.equal(got.certain, certain);
  });
}

/** pandas builds the same frames with different words. */
const PANDAS = 'import pandas as pd\ndf = pd.read_parquet("a.parquet")\n';

const PANDAS_CASES = [
  ['a column list', `${PANDAS}n = df[["a", "b"]]\nn.groupby("|")`, ['a', 'b'], true],
  ['rename columns=', `${PANDAS}n = df.rename(columns={"a": "z"})\nn.groupby("|")`, ['z', 'b', 'c'], true],
  ['drop columns=', `${PANDAS}n = df.drop(columns=["b"])\nn.groupby("|")`, ['a', 'c'], true],
  ['assign', `${PANDAS}n = df.assign(total=1)\nn.groupby("|")`, ['a', 'b', 'c', 'total'], true],
  ['identity methods', `${PANDAS}n = df.dropna().sort_values("a").head(3)\nn.groupby("|")`, ['a', 'b', 'c'], true],
  ['a single column stays the frame', `${PANDAS}n = df[["a"]]\nn.groupby("|")`, ['a'], true]
];

for (const [name, snippet, expected, certain] of PANDAS_CASES) {
  test(`propagates through pandas: ${name}`, async () => {
    const got = await columnsAt(snippet);
    assert.ok(got, 'no frame resolved');
    assert.deepEqual(got.names, expected);
    assert.equal(got.certain, certain);
  });
}

test('a pandas merge suffixes the way pandas does', async () => {
  const got = await columnsAt(
    'import pandas as pd\n' +
    'a = pd.read_parquet("a.parquet")\n' +
    'b = pd.read_parquet("b.parquet")\n' +
    'n = a.merge(b, on="a")\nn.groupby("|")'
  );
  // The shared key drops from the right; the rest collide and take _y, not _right.
  assert.deepEqual(got.names, ['a', 'b', 'c', 'b_y', 'c_y']);
});

test('an explicit suffixes= is honoured', async () => {
  const got = await columnsAt(
    'import pandas as pd\n' +
    'a = pd.read_parquet("a.parquet")\n' +
    'b = pd.read_parquet("b.parquet")\n' +
    'n = a.merge(b, on="a", suffixes=("_l", "_r"))\nn.groupby("|")'
  );
  assert.deepEqual(got.names, ['a', 'b', 'c', 'b_r', 'c_r']);
});

/** Selectors that pick by name or dtype, against a source with mixed dtypes. */
const SELECTOR_CASES = [
  ['cs.numeric', `${CS}n = df.select(cs.numeric())\nn.select("|")`, ['revenue', 'units']],
  ['cs.string', `${CS}n = df.select(cs.string())\nn.select("|")`, ['region']],
  ['cs.temporal', `${CS}n = df.select(cs.temporal())\nn.select("|")`, ['order_date']],
  ['cs.starts_with', `${CS}n = df.select(cs.starts_with("re"))\nn.select("|")`, ['region', 'revenue']],
  ['cs.ends_with', `${CS}n = df.select(cs.ends_with("s"))\nn.select("|")`, ['units']],
  ['cs.contains', `${CS}n = df.select(cs.contains("_"))\nn.select("|")`, ['order_date']],
  ['cs.matches', `${CS}n = df.select(cs.matches("^re"))\nn.select("|")`, ['region', 'revenue']],
  ['difference', `${CS}n = df.select(cs.numeric() - cs.by_name("units"))\nn.select("|")`, ['revenue']],
  ['intersection', `${CS}n = df.select(cs.numeric() & cs.starts_with("re"))\nn.select("|")`, ['revenue']],
  ['drop by selector', `${CS}n = df.drop(cs.temporal())\nn.select("|")`, ['region', 'revenue', 'units']]
];

for (const [name, snippet, expected] of SELECTOR_CASES) {
  test(`narrows through a selector: ${name}`, async () => {
    const got = await columnsAt(snippet, TYPED_COLUMNS);
    assert.ok(got, 'no frame resolved');
    assert.deepEqual(got.names, expected);
    assert.equal(got.certain, true, 'a selector we can evaluate is not a guess');
  });
}

test('a dtype selector stays quiet when the dtypes are unknown', async () => {
  // A CSV read without dtype inference has names but no types; picking the
  // "numeric" ones out of that would be invention.
  const blank = TYPED_COLUMNS.map((c) => ({ ...c, dtype: '' }));
  const got = await columnsAt(`${CS}n = df.select(cs.numeric())\nn.select("|")`, blank);
  assert.equal(got.certain, false);
  assert.equal(got.names.length, blank.length, 'keeps offering what it had');
});

/** When a step cannot be modelled, keep the columns but stop claiming certainty. */
const UNCERTAIN = [
  ['a reshape we do not model', `${HEAD}n = df.unpivot()\nn.select("|")`],
  ['a selector on a module we never saw imported', `${HEAD}n = df.select(cs.numeric())\nn.select("|")`],
  ['a selector taking arguments we do not model', `${CS}n = df.select(cs.by_dtype(pl.Int64))\nn.select("|")`],
  ['a method on top of a selector', `${CS}n = df.select(cs.numeric().meta.output_name())\nn.select("|")`],
  ['a regex column pattern', `${HEAD}n = df.select("^a.*$")\nn.select("|")`],
  ['a rename with a computed key', `${HEAD}n = df.rename({key: "z"})\nn.select("|")`],
  ['an unknown helper method', `${HEAD}n = df.my_helper()\nn.select("|")`],
  ['pandas moving a column into the index', `${PANDAS}n = df.set_index("a")\nn.groupby("|")`],
  ['a duckdb projection, which is SQL we do not parse', `${PANDAS}n = df.project("a, b")\nn.groupby("|")`]
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
  const ctx = {
    polarsAliases: new Set(['pl']),
    bareExprFuncs: new Set(),
    selectorAliases: new Set(['cs']),
    bareSelectorFuncs: new Set()
  };
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
  assert.deepEqual(nameOf('cs.by_name("a")'), { kind: 'names', names: ['a'] });
  assert.deepEqual(nameOf('cs.exclude("a")'), { kind: 'except', names: ['a'] });
  assert.equal(nameOf('cs.numeric()').kind, 'match');
  assert.equal(nameOf('cs.by_dtype(pl.Int64)').kind, 'unknown');
  // Set algebra. The union lives here rather than in the propagation corpus
  // above because `|` is also that corpus's cursor marker.
  const union = nameOf('cs.string() | cs.temporal()');
  assert.equal(union.kind, 'match');
  assert.deepEqual(TYPED_COLUMNS.filter(union.test).map((c) => c.name), ['region', 'order_date']);
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
