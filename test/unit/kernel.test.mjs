import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartFetchSnippet, parseChartJson, MARKER, buildChart } from '../harness.mjs';

/**
 * The two halves of the kernel read that can be tested without a kernel: the
 * Python that goes out, and the JSON that comes back. The wire in between is the
 * thin part; these are the parts a mistake would hide in.
 */

const wrap = (obj) => `${MARKER}${JSON.stringify(obj)}${MARKER}`;

test('the snippet addresses the output history first, then the variable', () => {
  const code = chartFetchSnippet({ outputRef: 12, symbol: 'x' }, ['a', 'b'], 5000);
  // The frame the cell already computed is _oh[n]: reading it re-runs nothing.
  assert.match(code, /_ref = 12/);
  assert.match(code, /_oh\.get\(_ref\)/);
  // The named variable is the fallback, collected if it is lazy.
  assert.match(code, /_sym = "x"/);
  assert.match(code, /isinstance\(_df, _ps_pl\.LazyFrame\)/);
  // Only the columns asked for cross the wire, capped like the file read.
  assert.match(code, /_ps_json\.loads\("\[\\"a\\",\\"b\\"\]"\)/);
  assert.match(code, /_n = 5000/);
  // And the answer is one sentinel-wrapped line, so a stray print is not it.
  assert.ok(code.includes(MARKER));
});

test('a missing address is None, not a hole to run code through', () => {
  const code = chartFetchSnippet({}, ['a'], 100);
  assert.match(code, /_ref = None/);
  assert.match(code, /_sym = None/);
});

test('a symbol that is not a plain name is refused, never interpolated', () => {
  // The symbol comes from the user's own source; a name is a lookup key, and
  // anything that is not one could only be an attempt to smuggle in code.
  const code = chartFetchSnippet({ symbol: 'x); import os; os.system("bad"' }, ['a'], 100);
  assert.match(code, /_sym = None/);
  assert.ok(!code.includes('os.system'));
});

test('the kernel JSON becomes the same read the file readers hand buildChart', () => {
  const parsed = parseChartJson(wrap({
    columns: [
      { name: 'boro_nm', family: 'category', values: ['MANHATTAN', 'QUEENS', 'BRONX'] },
      { name: 'dt_mean', family: 'duration', values: [1_000_000, 2_000_000, 3_000_000] }
    ],
    rowCount: 3,
    complete: true
  }));
  assert.ok('read' in parsed, 'expected a read');
  const { read } = parsed;
  // Families map onto the dtypes the chart's own code already understands — a
  // duration keeps a duration dtype so it is measured but reads back as a span.
  assert.equal(read.series[0].dtype, 'str');
  assert.equal(read.series[1].dtype, 'duration[μs]');
  assert.equal(read.rowsRead, 3);
  assert.equal(read.complete, true);

  // And it draws: a label column against a computed magnitude is a bar per
  // group, which is the whole point of reaching the kernel at all. One row per
  // group, so the mean of a group is the value the cell computed — and the
  // measured axis is flagged a duration so the page formats it as time.
  const chart = buildChart(read, { x: 'boro_nm', y: 'dt_mean', maxRows: 1000 });
  assert.equal(chart.kind, 'bar');
  assert.equal(chart.points.length, 3);
  assert.equal(chart.agg, 'mean');
  assert.equal(chart.yDuration, true);
  assert.deepEqual(chart.points.map((p) => p.label).sort(), ['BRONX', 'MANHATTAN', 'QUEENS']);
});

test('a temporal column comes back as epoch millis the axis can place', () => {
  const parsed = parseChartJson(wrap({
    columns: [{ name: 'day', family: 'temporal', values: [0, 86_400_000] }],
    rowCount: 2, complete: true
  }));
  assert.ok('read' in parsed);
  assert.equal(parsed.read.series[0].dtype, 'datetime[ms]');
});

test('an incomplete read is carried through, so the chart says it is a sample', () => {
  const parsed = parseChartJson(wrap({
    columns: [{ name: 'a', family: 'number', values: [1, 2] }],
    rowCount: 4_000_000, complete: false
  }));
  assert.ok('read' in parsed);
  assert.equal(parsed.read.complete, false);
  assert.equal(parsed.read.rowCount, 4_000_000);
});

test('anything that is not the frame we asked for is a miss, not a throw', () => {
  // The snippet reports its own refusals as an error field.
  assert.deepEqual(parseChartJson(wrap({ error: 'not-a-frame' })), { error: 'not-a-frame' });
  assert.deepEqual(parseChartJson(wrap({ error: 'no-polars' })), { error: 'no-polars' });
  // No sentinel at all — a kernel that printed nothing, or a bare traceback.
  assert.deepEqual(parseChartJson('some traceback, no marker'), { error: 'no-output' });
  // Sentinels around something that is not JSON.
  assert.deepEqual(parseChartJson(`${MARKER}not json${MARKER}`), { error: 'bad-json' });
  // JSON, but not the shape promised — no columns array.
  assert.deepEqual(parseChartJson(`${MARKER}{"rows":3}${MARKER}`), { error: 'no-columns' });
  // A column missing its values is a bad column, not a chart of nothing.
  assert.deepEqual(
    parseChartJson(`${MARKER}{"columns":[{"name":"a","family":"number"}]}${MARKER}`),
    { error: 'bad-column' }
  );
});
