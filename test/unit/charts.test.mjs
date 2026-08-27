import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChart, kindsFor, familyOf, defaultAxis, readParquetSeries, readCsvSeries, localStorage
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');
const file = (name) => path.join(DATA, name);

/** A column, and a read of one or two of them, without a file behind either. */
const col = (name, dtype, values) => ({ name, dtype, values });
const read = (series, extra = {}) => ({
  series,
  rowsRead: series[0]?.values.length ?? 0,
  rowCount: series[0]?.values.length,
  complete: true,
  ...extra
});
const chart = (series, request) =>
  buildChart(read(series), { maxRows: 1000, ...request });

/**
 * The lookup table, which is the whole of the choosing half. It is written out
 * here rather than exercised through a file because the point of it being a
 * table is that every row of it can be read at once.
 */
test('the chart a pair of columns gets is a lookup, not a guess', () => {
  assert.deepEqual(kindsFor('number'), ['histogram', 'bar']);
  assert.deepEqual(kindsFor('temporal'), ['histogram', 'bar']);
  assert.deepEqual(kindsFor('category'), ['bar']);
  assert.equal(kindsFor('number', 'number')[0], 'scatter');
  assert.equal(kindsFor('temporal', 'number')[0], 'line');
  assert.deepEqual(kindsFor('category', 'number'), ['bar']);
  // The list is also the override's list: a kind missing from it is one these
  // two columns cannot be drawn as.
  assert.ok(!kindsFor('category', 'number').includes('scatter'));
});

test('a dtype names the family, and values answer where there is no dtype', () => {
  assert.equal(familyOf('f64'), 'number');
  assert.equal(familyOf('i32'), 'number');
  assert.equal(familyOf('decimal[18,2]'), 'number');
  assert.equal(familyOf('date'), 'temporal');
  assert.equal(familyOf('datetime[μs, UTC]'), 'temporal');
  assert.equal(familyOf('str'), 'category');
  assert.equal(familyOf('bool'), 'category');
  assert.equal(familyOf('list[str]'), 'nested');
  // A CSV with dtype inference off has nothing but the values, and refusing to
  // chart it on that ground would be refusing to chart most CSVs.
  assert.equal(familyOf('', ['1.5', '2', '3']), 'number');
  assert.equal(familyOf('', ['EU', 'US', 'APAC']), 'category');
  // One "n/a" in a price column does not make the column text.
  assert.equal(familyOf('', ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'n/a']), 'number');
  assert.equal(familyOf('', []), 'category');
});

test('a frame opens on its first numeric column, and never on a list', () => {
  assert.equal(defaultAxis([
    { name: 'region', dtype: 'str' }, { name: 'revenue', dtype: 'f64' }
  ]), 'revenue');
  assert.equal(defaultAxis([
    { name: 'tags', dtype: 'list[str]' }, { name: 'region', dtype: 'str' }
  ]), 'region');
  assert.equal(defaultAxis([{ name: 'tags', dtype: 'list[str]' }]), undefined);
});

test('one numeric column is binned, and the axis runs to the edges of the bins', () => {
  const drawn = chart([col('revenue', 'f64', Array.from({ length: 200 }, (_, i) => i))],
    { x: 'revenue' });
  assert.equal(drawn.kind, 'histogram');
  assert.equal(drawn.points.length, 30);
  assert.equal(drawn.points.reduce((total, point) => total + point.y, 0), 200);
  assert.equal(drawn.yLabel, 'rows');
  // Midpoints are drawn; the domain is the outer edges, because an axis that
  // stops at the middle of the last bar lies about the largest value.
  assert.deepEqual(drawn.domain, [0, 199]);
  assert.equal(drawn.ticks.length, 5);
  assert.equal(drawn.ticks[0].label, '0');
  assert.equal(drawn.ticks.at(-1).label, '199');
  assert.equal(drawn.xNumeric, true);
});

test('a numeric column with a handful of values is bars, not a comb', () => {
  // Thirty bins over five values is a comb rather than a distribution — and a
  // rating written as a number is a set of categories.
  const drawn = chart([col('rating', 'i64', [5, 4, 5, 3, 5, 4])], { x: 'rating' });
  assert.equal(drawn.kind, 'bar');
  assert.equal(drawn.xNumeric, false);
  assert.deepEqual(drawn.points.map((point) => point.label), ['5', '4', '3']);
  assert.deepEqual(drawn.points.map((point) => point.y), [3, 2, 1]);
});

test('one categorical column is a bar of counts, most common first', () => {
  const region = [...Array(40).fill('APAC'), ...Array(60).fill('EU'), ...Array(100).fill('US')];
  const drawn = chart([col('region', 'str', region)], { x: 'region' });
  assert.equal(drawn.kind, 'bar');
  assert.deepEqual(drawn.points.map((point) => point.label), ['US', 'EU', 'APAC']);
  assert.deepEqual(drawn.points.map((point) => point.y), [100, 60, 40]);
  assert.equal(drawn.yLabel, 'rows');
});

test('too many categories are cut down to the ones worth drawing, and it says so', () => {
  const many = Array.from({ length: 200 }, (_, i) => `ord-${i}`);
  const drawn = chart([col('order_id', 'str', many)], { x: 'order_id' });
  assert.equal(drawn.points.length, 24);
  assert.ok(drawn.notes.some((note) => /200 distinct values/.test(note)), drawn.notes.join(' | '));
});

test('a category against a number is a bar of means, and the axis says mean', () => {
  const drawn = chart([
    col('region', 'str', ['EU', 'US', 'EU', 'US']),
    col('revenue', 'f64', [10, 1, 20, 3])
  ], { x: 'region', y: 'revenue' });
  assert.equal(drawn.kind, 'bar');
  // A bar of means and a bar of totals look identical, so which it is has to be
  // written on the axis rather than left to the reader.
  assert.equal(drawn.yLabel, 'mean revenue');
  assert.deepEqual(drawn.points.map((point) => [point.label, point.y]), [['EU', 15], ['US', 2]]);
});

test('the bar measures what it was asked to measure, and says which on the axis', () => {
  const columns = [
    col('region', 'str', ['EU', 'US', 'EU', 'US', 'EU']),
    col('revenue', 'f64', [10, 1, 20, 3, 60])
  ];
  const per = (agg) => {
    const drawn = chart(columns, { x: 'region', y: 'revenue', agg });
    return [drawn.yLabel, Object.fromEntries(drawn.points.map((p) => [p.label, p.y]))];
  };

  assert.deepEqual(per(undefined), ['mean revenue', { EU: 30, US: 2 }], 'mean is the default');
  assert.deepEqual(per('sum'), ['sum revenue', { EU: 90, US: 4 }]);
  assert.deepEqual(per('median'), ['median revenue', { EU: 20, US: 2 }]);
  assert.deepEqual(per('min'), ['min revenue', { EU: 10, US: 1 }]);
  assert.deepEqual(per('max'), ['max revenue', { EU: 60, US: 3 }]);
  // Counting rows is not counting revenue, so the axis stops naming the column.
  assert.deepEqual(per('count'), ['rows', { EU: 3, US: 2 }]);
  // The bars are ordered by what is being measured, not by what was measured last.
  assert.deepEqual(chart(columns, { x: 'region', y: 'revenue', agg: 'min' })
    .points.map((p) => p.label), ['EU', 'US']);
  assert.deepEqual(chart(columns, { x: 'region', y: 'revenue', agg: 'count' })
    .points.map((p) => p.label), ['EU', 'US']);
});

test('an even group takes the middle two, and an aggregate nobody offers is ignored', () => {
  const columns = [col('region', 'str', ['EU', 'EU', 'EU', 'EU']), col('n', 'f64', [1, 2, 3, 10])];
  assert.equal(chart(columns, { x: 'region', y: 'n', agg: 'median' }).points[0].y, 2.5);
  assert.equal(chart(columns, { x: 'region', y: 'n', agg: 'mode' }).agg, 'mean');
});

test('the aggregate is offered where there is a choice and nowhere else', () => {
  const grouped = chart([
    col('region', 'str', ['EU']), col('revenue', 'f64', [1])
  ], { x: 'region', y: 'revenue' });
  assert.deepEqual(grouped.aggs, ['count', 'sum', 'mean', 'median', 'min', 'max']);
  // Counting is all there is to do with one column of labels, and a scatter
  // draws the rows themselves — neither has anything to pick.
  assert.deepEqual(chart([col('region', 'str', ['EU'])], { x: 'region' }).aggs, []);
  assert.deepEqual(chart([
    col('units', 'i64', [1, 2]), col('revenue', 'f64', [1, 2])
  ], { x: 'units', y: 'revenue' }).aggs, []);
});

test('the columns are swapped rather than refused when they are the wrong way round', () => {
  const drawn = chart([
    col('revenue', 'f64', [10, 1, 20, 3]),
    col('region', 'str', ['EU', 'US', 'EU', 'US'])
  ], { x: 'revenue', y: 'region' });
  assert.equal(drawn.x, 'region');
  assert.equal(drawn.y, 'revenue');
  assert.equal(drawn.kind, 'bar');
});

test('a date against a number is a line, in date order, on a time axis', () => {
  const days = [new Date('2026-03-01'), new Date('2026-01-01'), new Date('2026-02-01')];
  const drawn = chart([
    col('order_date', 'date', days),
    col('units', 'i64', [30, 10, 20])
  ], { x: 'order_date', y: 'units' });
  assert.equal(drawn.kind, 'line');
  assert.deepEqual(drawn.points.map((point) => point.y), [10, 20, 30], 'the line was not sorted');
  assert.equal(drawn.points[0].label, '2026-01-01');
  assert.equal(drawn.ticks[0].label, '2026-01-01');
  assert.equal(drawn.yLabel, 'units');
});

test('two numbers are a scatter, and the override picks another kind from the list', () => {
  const columns = [
    col('units', 'i64', [1, 2, 3]),
    col('revenue', 'f64', [10, 20, 30])
  ];
  assert.equal(chart(columns, { x: 'units', y: 'revenue' }).kind, 'scatter');
  assert.equal(chart(columns, { x: 'units', y: 'revenue', kind: 'line' }).kind, 'line');
  // A kind these columns cannot be drawn as is ignored rather than obeyed.
  assert.equal(chart(columns, { x: 'units', y: 'revenue', kind: 'histogram' }).kind, 'scatter');
});

test('rows with nothing in them are skipped, and the count is said out loud', () => {
  const drawn = chart([col('revenue', 'f64', [1, null, 3, null])], { x: 'revenue' });
  assert.ok(drawn.notes.some((note) => /2 rows skipped/.test(note)), drawn.notes.join(' | '));
  const paired = chart([
    col('region', 'str', ['EU', 'US', null]),
    col('revenue', 'f64', [1, null, 3])
  ], { x: 'region', y: 'revenue' });
  assert.equal(paired.points.length, 1);
  assert.ok(paired.notes.some((note) => /2 rows skipped/.test(note)), paired.notes.join(' | '));
});

test('a column with nothing in it says so rather than drawing an empty chart', () => {
  const drawn = chart([col('empty', 'str', [null, null])], { x: 'empty' });
  assert.deepEqual(drawn.points, []);
  assert.match(drawn.empty, /nothing in it to draw/);
});

test('what cannot be drawn is refused in words, not in an empty panel', () => {
  const nested = chart([col('tags', 'list[str]', [['a'], ['b']])], { x: 'tags' });
  assert.match(nested.empty, /list or struct/);

  const twoLabels = chart([
    col('region', 'str', ['EU']), col('notes', 'str', ['a'])
  ], { x: 'region', y: 'notes' });
  assert.match(twoLabels.empty, /labels rather than numbers/);

  const missing = chart([col('region', 'str', ['EU'])], { x: 'nope' });
  assert.match(missing.empty, /not a column of this file/);
});

test('a read that stopped short is called a sample', () => {
  const drawn = buildChart(
    read([col('revenue', 'f64', [1, 2, 3])], { complete: false, rowCount: 4_000_000 }),
    { x: 'revenue', maxRows: 3 }
  );
  assert.ok(drawn.notes.some((note) => /sample of the file/.test(note)), drawn.notes.join(' | '));
  const csv = buildChart(
    read([col('revenue', '', ['1', '2'])], { complete: false, prefixBytes: 262144 }),
    { x: 'revenue', maxRows: 10 }
  );
  assert.ok(csv.notes.some((note) => /prefix, not the file/.test(note)), csv.notes.join(' | '));
});

/**
 * The reader under all of it. Two columns of a file, capped — which is the
 * whole cost model: a chart of a four-million-row file reads maxRows of the one
 * or two columns being drawn and nothing else.
 */
test('the series reader takes the columns asked for and stops where it is told', async () => {
  const whole = await readParquetSeries(localStorage, file('values.parquet'), {
    columns: ['region', 'revenue'], maxRows: 1000
  });
  assert.deepEqual(whole.series.map((series) => series.name), ['region', 'revenue']);
  assert.deepEqual(whole.series.map((series) => series.dtype), ['str', 'f64']);
  assert.equal(whole.rowsRead, 200);
  assert.equal(whole.rowCount, 200);
  assert.equal(whole.complete, true);
  assert.equal(whole.series[0].values[0], 'APAC');
  assert.equal(whole.series[1].values[199], 199);

  const capped = await readParquetSeries(localStorage, file('values.parquet'), {
    columns: ['revenue'], maxRows: 50
  });
  assert.equal(capped.rowsRead, 50);
  assert.equal(capped.complete, false, 'a capped read is not the whole file');

  // A column the file does not have is left out rather than filled with nulls.
  const unknown = await readParquetSeries(localStorage, file('values.parquet'), {
    columns: ['nope'], maxRows: 10
  });
  assert.deepEqual(unknown.series, []);
});

test('a CSV series comes out of the same prefix everything else here reads', async () => {
  const whole = await readCsvSeries(file('sales.csv'), {}, { sniffBytes: 262144 }, {
    columns: ['region', 'revenue'], maxRows: 100
  });
  assert.deepEqual(whole.series.map((series) => series.name), ['region', 'revenue']);
  assert.deepEqual(whole.series[0].values, ['EU', 'US', 'APAC']);
  // Strings, because a CSV has no dtypes to hand back: what parses as a number
  // is the chart's decision.
  assert.deepEqual(whole.series[1].values, ['1.5', '2.25', '3.0']);
  assert.equal(whole.complete, true);
  assert.equal(whole.prefixBytes, undefined);

  const short = await readCsvSeries(file('sales.csv'), {}, { sniffBytes: 120 }, {
    columns: ['region'], maxRows: 100
  });
  assert.equal(short.prefixBytes, 120);
  assert.equal(short.complete, false);
});

test('a chart of a real file is the file, not a page of it', async () => {
  const values = await readParquetSeries(localStorage, file('values.parquet'), {
    columns: ['region'], maxRows: 100_000
  });
  const drawn = buildChart(values, { x: 'region', maxRows: 100_000 });
  assert.equal(drawn.kind, 'bar');
  assert.deepEqual(drawn.points.map((point) => [point.label, point.y]),
    [['US', 100], ['EU', 60], ['APAC', 40]]);
  assert.deepEqual(drawn.notes, [], 'a complete read has nothing to apologise for');
});
