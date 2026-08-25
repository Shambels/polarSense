import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarked, analyzeSource, resolveAtOffset } from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PL = 'import polars as pl\ndf = pl.scan_parquet("a.parquet")\n';

/**
 * `df.filter(region="EU")` is the only column position outside a string, so `|`
 * here marks a cursor in bare code rather than inside quotes.
 */
const CASES = [
  ['a keyword being typed', `${PL}df.filter(reg|)`],
  ['an empty argument list', `${PL}df.filter(|)`],
  ['a complete keyword', `${PL}df.filter(reg|ion="EU")`],
  ['the start of the name', `${PL}df.filter(|region="EU")`],
  ['a second constraint', `${PL}df.filter(region="EU", uni|ts=3)`],
  ['after a positional predicate', `${PL}df.filter(x > 1, reg|)`],
  ['remove takes them too', `${PL}df.remove(reg|)`],
  ['through a chain', `${PL}df.sort("x").filter(reg|)`],
  ['on a lazy frame from a function', `${PL}def load():\n    return pl.scan_parquet("a.parquet")\n\nload().filter(reg|)`]
];

for (const [name, snippet] of CASES) {
  test(`constraint keyword: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, 'a.parquet', `failure was: ${res.failure ?? 'none'}`);
    assert.equal(res.keywordSite, true);
  });
}

test('the range covers the name being typed, and nothing else', async () => {
  const source = `${PL}df.filter(region="EU")`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const at = source.indexOf('region=');
  const res = resolveAtOffset(tree, table, at + 3);
  assert.equal(source.slice(res.contentStart, res.contentEnd), 'region');
});

test('an empty argument list has nothing to replace', async () => {
  const source = `${PL}df.filter()`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const at = source.indexOf('filter(') + 7;
  const res = resolveAtOffset(tree, table, at);
  assert.equal(res.keywordSite, true);
  assert.equal(res.contentStart, res.contentEnd);
});

const NOTHING = [
  ['the value of a constraint', `${PL}df.filter(region=E|U)`],
  ['a method that takes no constraints', `${PL}df.select(reg|)`],
  ['a keyword that names a new column', `${PL}df.with_columns(tot|al=1)`],
  ['an argument of an unrelated call', `${PL}print(reg|)`],
  ['a frame we cannot identify', 'import polars as pl\nmystery.filter(reg|)'],
  ['inside a nested expression', `${PL}df.filter(pl.co|l("x") > 1)`],
  ['a bare filter with no receiver', `${PL}filter(reg|)`]
];

for (const [name, snippet] of NOTHING) {
  test(`offers nothing: ${name}`, async () => {
    const res = await resolveMarked(snippet, ROOT);
    assert.equal(res.source?.path, undefined, 'unexpectedly resolved');
  });
}

test('a string inside a constraint is still not a column', async () => {
  // `region="EU"` — the value is data. The keyword beside it is the column.
  const res = await resolveMarked(`${PL}df.filter(region="|EU")`, ROOT);
  assert.equal(res.source?.path, undefined);
});

test('constraints narrow through the transforms above them', async () => {
  const source = `${PL}n = df.select("a", "b")\nn.filter(a=1)`;
  const { tree, table } = await analyzeSource(source, ROOT);
  const res = resolveAtOffset(tree, table, source.lastIndexOf('a=1'));
  assert.ok(res.frame, 'no frame resolved');
  assert.equal(res.frame.kind, 'transform');
  assert.equal(res.keywordSite, true);
});
