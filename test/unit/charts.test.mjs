import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChart, kindsFor, familyOf, defaultAxis, truncate, readParquetSeries, readCsvSeries,
  formatValue, localStorage
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

test('a date against labels is one line per label, counting the rows', () => {
  const day = (n) => new Date(`2026-01-0${n}`);
  const drawn = chart([
    col('created_at', 'date', [day(1), day(1), day(2), day(1), day(2), day(2)]),
    col('region', 'str', ['EU', 'US', 'EU', 'EU', 'US', 'US'])
  ], { x: 'created_at', y: 'region' });

  // The second column is not a measurement: it says which line the row is on.
  assert.equal(drawn.kind, 'line');
  assert.deepEqual(drawn.kinds, ['line', 'scatter']);
  assert.deepEqual(drawn.seriesNames, ['EU', 'US']);
  assert.equal(drawn.yLabel, 'rows');
  assert.equal(drawn.xNumeric, true);
  const per = (name) => drawn.points.filter((point) => point.series === name)
    .map((point) => [point.label, point.y]);
  assert.deepEqual(per('EU'), [['2026-01-01', 2], ['2026-01-02', 1]]);
  assert.deepEqual(per('US'), [['2026-01-01', 1], ['2026-01-02', 2]]);
  // Exact dates while there are few of them: no note about buckets.
  assert.deepEqual(drawn.notes, []);
  // Nothing to aggregate — counting rows is the only thing on offer.
  assert.deepEqual(drawn.aggs, []);
});

test('a timestamp is moved to the start of its period, on the clock the panel prints', () => {
  // UTC, because formatValue goes through toISOString: grouping on the local
  // clock would put a row in a month the panel does not show it in.
  const at = (iso) => Date.parse(iso);
  const on = (ms, grain) => new Date(truncate(ms, grain)).toISOString();

  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'year'), '2026-01-01T00:00:00.000Z');
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'month'), '2026-03-01T00:00:00.000Z');
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'day'), '2026-03-17T00:00:00.000Z');
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'hour'), '2026-03-17T14:00:00.000Z');
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'minute'), '2026-03-17T14:37:00.000Z');
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'second'), '2026-03-17T14:37:52.000Z');
  // A week starts on Monday: the 17th is a Tuesday, so it belongs to the 16th,
  // and the Monday itself stays where it is.
  assert.equal(on(at('2026-03-17T14:37:52.481Z'), 'week'), '2026-03-16T00:00:00.000Z');
  assert.equal(on(at('2026-03-16T00:00:00.000Z'), 'week'), '2026-03-16T00:00:00.000Z');
  // Sunday is the end of its week, not the start of the next one.
  assert.equal(on(at('2026-03-22T23:59:59.000Z'), 'week'), '2026-03-16T00:00:00.000Z');
});

test('a date column can be grouped by period, and only a date column is offered it', () => {
  const stamps = [
    '2026-01-05T09:00:00Z', '2026-01-20T11:00:00Z', '2026-02-02T08:00:00Z',
    '2026-02-14T22:00:00Z', '2026-02-28T01:00:00Z'
  ].map((iso) => new Date(iso));

  const monthly = chart([col('created_at', 'datetime[μs]', stamps)],
    { x: 'created_at', grain: 'month' });
  assert.equal(monthly.grain, 'month');
  assert.equal(monthly.kind, 'line', 'a period is a run of time, so it is a line by default');
  assert.deepEqual(monthly.points.map((point) => [point.label, point.y]),
    [['2026-01-01', 2], ['2026-02-01', 3]]);
  assert.equal(monthly.yLabel, 'rows');
  assert.equal(monthly.xLabel, 'created_at by month');
  // Bars are a fair reading of one count per month, so they are on the list.
  assert.deepEqual(monthly.kinds, ['line', 'bar', 'scatter']);

  const yearly = chart([col('created_at', 'datetime[μs]', stamps)],
    { x: 'created_at', grain: 'year' });
  assert.deepEqual(yearly.points.map((point) => [point.label, point.y]), [['2026-01-01', 5]]);

  // The choices are offered before one is made, and only where they mean something.
  assert.deepEqual(chart([col('created_at', 'date', stamps)], { x: 'created_at' }).grains,
    ['year', 'month', 'week', 'day', 'hour', 'minute', 'second']);
  assert.deepEqual(chart([col('revenue', 'f64', [1, 2, 3])], { x: 'revenue' }).grains, []);
  assert.deepEqual(chart([col('region', 'str', ['EU'])], { x: 'region' }).grains, []);
  // Temporal is not the same question as dated: a length of time and a time of
  // day have no calendar to be grouped on, and grouping them by month would
  // read them as milliseconds since 1970.
  assert.deepEqual(chart([col('elapsed', 'duration[μs]', [1, 2])], { x: 'elapsed' }).grains, []);
  assert.deepEqual(chart([col('opens_at', 'time', [1, 2])], { x: 'opens_at' }).grains, []);
  assert.equal(chart([col('at', 'datetime[μs, UTC]', stamps)], { x: 'at' }).grains.length, 7);
  // ...and one asked for on a column that has no calendar is not applied either.
  assert.equal(chart([col('elapsed', 'duration[μs]', [1, 2])],
    { x: 'elapsed', grain: 'month' }).grain, undefined);
});

test('a period groups the other column too: a line each, or a measurement', () => {
  const stamps = ['2026-01-05', '2026-01-20', '2026-02-02', '2026-02-14']
    .map((iso) => new Date(iso));

  const split = chart([
    col('created_at', 'date', stamps),
    col('region', 'str', ['EU', 'US', 'EU', 'EU'])
  ], { x: 'created_at', y: 'region', grain: 'month' });
  assert.deepEqual(split.seriesNames, ['EU', 'US']);
  assert.deepEqual(split.points.filter((p) => p.series === 'EU').map((p) => [p.label, p.y]),
    [['2026-01-01', 1], ['2026-02-01', 2]]);
  // Two lines of bars would interleave, so bars are not offered for a split.
  assert.deepEqual(split.kinds, ['line', 'scatter']);

  // With a number to measure, the aggregate picker means something again.
  const measured = chart([
    col('created_at', 'date', stamps),
    col('revenue', 'f64', [10, 20, 1, 3])
  ], { x: 'created_at', y: 'revenue', grain: 'month', agg: 'sum' });
  assert.equal(measured.yLabel, 'sum revenue');
  assert.deepEqual(measured.points.map((p) => [p.label, p.y]),
    [['2026-01-01', 30], ['2026-02-01', 4]]);
  assert.ok(measured.aggs.includes('median'));
  // Without an aggregate named, the mean is what a measurement defaults to.
  assert.equal(chart([
    col('created_at', 'date', stamps), col('revenue', 'f64', [10, 20, 1, 3])
  ], { x: 'created_at', y: 'revenue', grain: 'month' }).points[0].y, 15);
});

test('a split falls back to buckets when every row has its own timestamp', () => {
  const stamps = Array.from({ length: 400 }, (_, i) => new Date(2026, 0, 1, 0, 0, 0, i));
  const drawn = chart([
    col('created_at', 'datetime[μs]', stamps),
    col('region', 'str', stamps.map((_, i) => (i % 2 ? 'EU' : 'US')))
  ], { x: 'created_at', y: 'region' });

  assert.deepEqual(drawn.seriesNames, ['EU', 'US']);
  // Thirty buckets a line, not four hundred points of one row each.
  assert.ok(drawn.points.length <= 60, `${drawn.points.length} points`);
  assert.equal(drawn.points.reduce((total, point) => total + point.y, 0), 400);
  assert.ok(drawn.notes.some((note) => /30 buckets/.test(note)), drawn.notes.join(' | '));
});

test('a split draws the six busiest labels and says how many it left out', () => {
  const n = 100;
  const drawn = chart([
    col('day', 'date', Array.from({ length: n }, (_, i) => new Date(2026, 0, 1 + (i % 10)))),
    col('region', 'str', Array.from({ length: n }, (_, i) => `r${i % 9}`))
  ], { x: 'day', y: 'region' });
  assert.equal(drawn.seriesNames.length, 6);
  assert.ok(drawn.notes.some((note) => /9 values; the 6 with the most rows/.test(note)),
    drawn.notes.join(' | '));
});

test('labels against labels is still a table rather than a chart', () => {
  const drawn = chart([
    col('region', 'str', ['EU']), col('notes', 'str', ['a'])
  ], { x: 'region', y: 'notes' });
  assert.match(drawn.empty, /both hold labels/);
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

test('a duration is a magnitude, so it is measured rather than refused', () => {
  // polars files a duration under time, but you sum and average it like a
  // number — so the chart treats it as one. A date stays a point on a calendar.
  assert.equal(familyOf('duration[μs]'), 'number');
  assert.equal(familyOf('duration[ns]'), 'number');
  assert.equal(familyOf('date'), 'temporal');

  // A label column against a duration is a bar per label with its rows averaged
  // — which is what a computed `dt_mean` per group is. Before durations were
  // numbers this pair drew nothing, on the grounds a duration was not a value.
  const drawn = chart([
    col('boro_nm', 'str', ['A', 'B', 'A', 'B']),
    col('elapsed', 'duration[μs]', [10, 20, 30, 50])
  ], { x: 'boro_nm', y: 'elapsed' });
  assert.equal(drawn.kind, 'bar');
  assert.equal(drawn.agg, 'mean');
  assert.equal(drawn.points.length, 2);
  // A → mean(10, 30) = 20, B → mean(20, 50) = 35, ordered by value.
  assert.deepEqual(drawn.points.map((p) => [p.label, p.y]), [['B', 35], ['A', 20]]);
});

test('a duration reads as a span of time, not a count of microseconds', () => {
  // The largest two units that carry it, from a value in the dtype's own unit.
  assert.equal(formatValue(1_191_600_000_000, 'duration[μs]'), '13d 19h');
  assert.equal(formatValue(900_000_000, 'duration[μs]'), '15m');
  assert.equal(formatValue(1_000, 'duration[μs]'), '1ms');
  assert.equal(formatValue(0, 'duration[μs]'), '0s');
  // Nanoseconds scale to the same answer: 13d 19h in ns is 13d 19h.
  assert.equal(formatValue(1_191_600_000_000_000, 'duration[ns]'), '13d 19h');
  // A plain number keeps its digits — only a duration dtype triggers the span.
  assert.equal(formatValue(1_191_600_000_000, 'i64'), '1191600000000');

  // And the chart only flags the axis a duration when the y column is one.
  const bars = buildChart(read([
    col('g', 'str', ['a', 'a']),
    col('n', 'i64', [3, 5])
  ]), { x: 'g', y: 'n', maxRows: 100 });
  assert.equal(bars.yDuration, undefined);
});