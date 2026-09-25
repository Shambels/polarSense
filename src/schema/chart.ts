import { formatValue } from './format.js';
import type { Series, SeriesRead } from './series.js';

/**
 * A chart, decided and computed in the extension host.
 *
 * Two halves, and only one of them is interesting. **Choosing** the chart is a
 * lookup table over dtype families: one numeric column is a histogram, one
 * categorical is a bar of counts, temporal against numeric is a line, numeric
 * against numeric is a scatter, categorical against numeric is a bar. That is
 * the whole inference engine, and it is a table rather than a heuristic because
 * the user can override it in one click — a default that can be changed costs
 * nothing when it is wrong, which is what makes a plain lookup defensible.
 *
 * **Computing** it is the half that matters, and the rule is the one the table
 * panel is already built on: a million rows must never cross the message
 * boundary. What leaves here is at most a few hundred points — bin counts,
 * category means, a sampled scatter — so a chart of a four-million-row file
 * costs the same message as a chart of four hundred.
 */

export type ChartKind = 'histogram' | 'bar' | 'line' | 'scatter';

/**
 * What a bar of grouped rows measures. `count` is the one that needs no numbers
 * — it is the rows in the group — which is also why a single categorical column
 * has no choice to make: counting is all there is to do with labels.
 */
export type Agg = 'count' | 'sum' | 'mean' | 'median' | 'min' | 'max';

export const AGGS: Agg[] = ['count', 'sum', 'mean', 'median', 'min', 'max'];

/**
 * How coarsely a temporal column is grouped. A timestamp is exact to the
 * microsecond, which makes every row its own point and every count a 1 — so the
 * question a date column is usually asked is "per what", and this is the answer
 * given rather than guessed.
 */
export type Grain = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

export const GRAINS: Grain[] = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];

/** The dtype families that behave differently when drawn, and nothing finer. */
export type Family = 'number' | 'temporal' | 'category' | 'nested';

export interface ChartRequest {
  /** The column on the x axis. */
  x: string;
  /** The second column, when there is one. */
  y?: string;
  /** The user's override, when they made one. Absent means the table decides. */
  kind?: ChartKind;
  /** What to measure per group. Only a bar of two columns has anything to apply. */
  agg?: Agg;
  /** The period a temporal x is grouped into. Ignored where x is not a date. */
  grain?: Grain;
  /**
   * A third column whose values each get a line, a bar or a colour of their
   * own. Ignored where y already holds labels — that column is the split then —
   * and where it names x or y.
   */
  split?: string;
  maxRows: number;
}

/** One mark. Numbers only — a label is what it is called, never what it is. */
export interface ChartPoint {
  x: number;
  y: number;
  label: string;
  /** Which line this point belongs to, where the chart was split into several. */
  series?: string;
  /**
   * The rows behind an aggregated value — a mean of three is not a mean of
   * three thousand, and the hover is where that difference gets said.
   */
  n?: number;
}

export interface Chart {
  kind: ChartKind;
  /** The kinds these columns can be drawn as, best first: the override's list. */
  kinds: ChartKind[];
  /** What was measured per group, and the choices — empty where there is nothing to choose. */
  agg?: Agg;
  aggs: Agg[];
  /** One name per line, in drawing order. Empty for a chart that is one line. */
  seriesNames: string[];
  /** The column the chart was split by, when a split was asked for and applied. */
  split?: string;
  /**
   * Whether a split column can be asked for at all. False where the y column
   * holds labels, because then it already is the split — offering a second one
   * would be offering a third dimension the chart has nowhere to put.
   */
  splittable: boolean;
  /** The period the rows were grouped into, and the choices — empty where x is not a date. */
  grain?: Grain;
  grains: Grain[];
  /** The columns actually used — the request's, unless they had to be swapped. */
  x: string;
  y?: string;
  xLabel: string;
  yLabel: string;
  /**
   * The x axis is a continuous scale rather than a row of labelled slots. It
   * decides whether the page draws ticks along a line or a caption under each
   * bar — a drawing decision taken from the data rather than inside it.
   */
  xNumeric: boolean;
  /**
   * The range the x axis covers, when it is a scale. Sent rather than left to
   * the page to work out from the points, because a histogram's axis runs to
   * the edges of its outer bins and the points are their midpoints.
   */
  domain?: [number, number];
  /** Where to write a value along that scale, formatted by the side that knows the dtype. */
  ticks: { x: number; label: string }[];
  points: ChartPoint[];
  rowsRead: number;
  rowCount?: number;
  /** Every row of the file went into these numbers. */
  complete: boolean;
  notes: string[];
  /** Set when there is nothing to draw, and says why rather than drawing nothing. */
  empty?: string;
  /**
   * The measured axis is a duration, so the page formats its ticks as a span of
   * time rather than as a count of microseconds. Set from the y column's dtype
   * once the axes have settled — a swap can move the duration from x to y.
   */
  yDuration?: boolean;
}

/** Bars past this many stop being a chart and start being a table. */
const MAX_BARS = 24;

/** Bins in a histogram. Enough shape to see, few enough to draw without a legend. */
const BINS = 30;

/** Marks in a scatter, and points in a line: past these they overplot anyway. */
const MAX_POINTS = 2000;
const MAX_LINE = 800;

/** Distinct values at or below which a numeric column is bars, not a histogram. */
const FEW = 12;

/** Lines drawn at once: the theme has six chart colours, and a legend needs them apart. */
const SERIES = 6;

/** Distinct x values kept as themselves before a split falls back to binning. */
const EXACT = 200;

/**
 * The temporal dtypes that are points on a calendar. A duration and a time of
 * day are temporal too and neither has one: grouping `3h 12m` by month reads it
 * as milliseconds since 1970, which is a number dressed as an answer.
 */
const CALENDAR = /^(date|datetime|timestamp)/;

/**
 * The family of a column: its dtype where the file recorded one, and what its
 * values look like where it did not. A CSV with dtype inference off has nothing
 * but the values, and refusing to chart it on that ground would be refusing to
 * chart most CSVs.
 */
export function familyOf(dtype: string, values: readonly unknown[] = []): Family {
  const d = dtype.toLowerCase();
  if (d) {
    if (/^(list|array|struct|object|binary|map)/.test(d)) return 'nested';
    // A duration is a quantity — you sum it and average it — not a point on a
    // calendar, so the chart measures it like the number it is, even though
    // polars files it under time. A date or a timestamp stays temporal.
    if (/^duration/.test(d)) return 'number';
    if (/^(date|time|timestamp)/.test(d)) return 'temporal';
    if (/^(i|u|f)\d/.test(d) || /^(int|uint|float|double|decimal|long|short)/.test(d)) {
      return 'number';
    }
    return 'category';
  }

  const sample = values.filter((value) => value !== null && value !== '').slice(0, 200);
  if (!sample.length) return 'category';
  const numbers = sample.filter((value) => Number.isFinite(toNumber(value, 'number'))).length;
  // A clear majority rather than all of them: one "n/a" in a price column does
  // not make the column text.
  return numbers / sample.length >= 0.9 ? 'number' : 'category';
}

/**
 * Which charts these columns can be, best first.
 *
 * The head of the list is the default and the whole list is what the override
 * offers — so a kind missing from it is one these two columns cannot be drawn
 * as, rather than one nobody thought of.
 */
export function kindsFor(x: Family, y?: Family): ChartKind[] {
  if (y === undefined) {
    if (x === 'category') return ['bar'];
    return ['histogram', 'bar'];
  }
  if (x === 'temporal') return ['line', 'scatter', 'bar'];
  if (x === 'category') return ['bar'];
  return ['scatter', 'line', 'bar'];
}

/**
 * The column a frame opens on, before anyone has chosen anything.
 *
 * The first numeric one, because a distribution is the question people usually
 * have about a file they have just found — and the first of anything else
 * otherwise, whose bar of counts at least says what is in it. Nested columns
 * are not offered at all: a chart of a list column is a chart of nothing.
 */
export function defaultAxis(
  columns: readonly { name: string; dtype: string }[]
): string | undefined {
  const drawable = columns.filter((column) => familyOf(column.dtype) !== 'nested');
  const numeric = drawable.find((column) => familyOf(column.dtype) === 'number');
  return (numeric ?? drawable[0])?.name;
}

/**
 * The read, turned into the few hundred numbers the page draws. The choosing and
 * computing is `computeChart`; this only marks the settled y axis as a duration
 * so the page formats a fortnight as `13d 19h` rather than as a wall of
 * microseconds. Looking it up by the returned y name is what survives the axis
 * swap, which can move a duration from the x the user picked onto the y.
 */
export function buildChart(read: SeriesRead, request: ChartRequest): Chart {
  const chart = computeChart(read, request);
  const ySeries = chart.y ? read.series.find((series) => series.name === chart.y) : undefined;
  // A count of rows is a count whatever column it was taken over: formatting
  // it as a span would print three rows as 3µs.
  return ySeries && isDuration(ySeries.dtype) && chart.yLabel !== 'rows'
    ? { ...chart, yDuration: true }
    : chart;
}

/** A duration dtype, however its unit is spelled — `duration[μs]`, `duration[ns]`. */
export function isDuration(dtype: string): boolean {
  return /^duration/i.test(dtype.trim().toLowerCase());
}

/**
 * The read, turned into the few hundred numbers the page draws.
 *
 * Everything expensive has already happened by the time this is called: this is
 * arithmetic over arrays that are in memory, which is why it is pure and can be
 * tested against a column of values rather than against a file.
 */
function computeChart(read: SeriesRead, request: ChartRequest): Chart {
  const find = (name: string | undefined) =>
    name === undefined ? undefined : read.series.find((series) => series.name === name);
  const xSeries = find(request.x);
  const ySeries = find(request.y);

  const base = {
    kinds: [] as ChartKind[],
    x: request.x,
    y: request.y,
    xLabel: request.x,
    yLabel: '',
    xNumeric: false,
    aggs: [] as Agg[],
    seriesNames: [] as string[],
    splittable: false,
    grains: [] as Grain[],
    ticks: [] as { x: number; label: string }[],
    points: [] as ChartPoint[],
    rowsRead: read.rowsRead,
    rowCount: read.rowCount,
    complete: read.complete,
    notes: readNotes(read)
  };

  if (!xSeries) {
    return { ...base, kind: 'bar', empty: `${request.x} is not a column of this file.` };
  }

  // A pair whose x is a number and whose y is not is the same chart the other
  // way round, and swapping beats refusing: nobody picks two columns in the
  // order the lookup table happens to want them.
  let first = textDates(xSeries);
  let second = ySeries && textDates(ySeries);
  let xFamily = familyOf(first.dtype, first.values);
  let yFamily = second ? familyOf(second.dtype, second.values) : undefined;
  if (second && yFamily && xFamily === 'number' && yFamily !== 'number') {
    [first, second] = [second, first];
    [xFamily, yFamily] = [yFamily, 'number'];
  }

  if (xFamily === 'nested' || yFamily === 'nested') {
    return {
      ...base,
      kind: 'bar',
      empty: 'A list or struct column has no shape to draw. Pick a column of numbers, ' +
        'dates or labels.'
    };
  }

  // A label on the measured axis is not a measurement: it says *which line this
  // row belongs to*, which is the only reading of it that draws anything. So it
  // is the split, and asking for another one on top is not offered — the chart
  // has an x, a y and a colour, and the colour is taken.
  const labelled = !!second && yFamily !== 'number';
  const value = labelled ? undefined : second;
  let by = labelled ? second : undefined;
  if (!labelled && request.split !== undefined &&
      request.split !== first.name && request.split !== second?.name) {
    const asked = find(request.split);
    if (asked && familyOf(asked.dtype, asked.values) !== 'nested') by = textDates(asked);
  }
  const splitBase = {
    ...base,
    splittable: !labelled,
    split: !labelled && by ? by.name : undefined
  };

  // A date grouped into periods: the rows counted per month, or a numeric column
  // measured per month, and split into a line each where a label column says so.
  // It is the same grouping the split already does, with the period as its key.
  const grains: Grain[] = xFamily === 'temporal' && CALENDAR.test(first.dtype.toLowerCase())
    ? GRAINS
    : [];
  const grain = grains.length && request.grain && GRAINS.includes(request.grain)
    ? request.grain
    : undefined;
  if (grain) {
    const periods = grouped(first, grain);
    const drawn = split(periods, 'temporal', by, value, request.agg);
    // Bars stand side by side per period when the chart is split, so they are a
    // fair reading of one line or of six.
    const names = drawn.seriesNames ?? [];
    const lines: ChartKind[] = ['line', 'bar', 'scatter'];
    const chosen = request.kind && lines.includes(request.kind) ? request.kind : 'line';
    return {
      ...splitBase,
      kinds: lines,
      kind: chosen,
      x: first.name,
      y: second?.name,
      xLabel: `${first.name} by ${grain}`,
      xNumeric: chosen !== 'bar',
      domain: chosen === 'bar' ? undefined : drawn.domain,
      ticks: chosen !== 'bar' && drawn.domain
        ? axisTicks(drawn.domain, periods.dtype, 'temporal')
        : [],
      points: drawn.points,
      yLabel: drawn.yLabel,
      agg: drawn.agg,
      aggs: drawn.aggs ?? [],
      seriesNames: names,
      grain,
      grains,
      empty: drawn.empty,
      notes: [...base.notes, ...drawn.notes]
    };
  }

  if (by) {
    const drawn = splitChart(first, xFamily, value, by, request);
    const xNumeric = drawn.kind !== 'bar';
    const domain = xNumeric
      ? drawn.domain ?? extent(drawn.points.map((point) => point.x))
      : undefined;
    return {
      ...splitBase,
      kinds: drawn.kinds,
      kind: drawn.kind,
      x: first.name,
      y: second?.name,
      xLabel: first.name,
      xNumeric,
      agg: drawn.agg,
      aggs: drawn.aggs ?? [],
      seriesNames: drawn.seriesNames ?? [],
      grains,
      domain,
      ticks: domain ? axisTicks(domain, first.dtype, xFamily) : [],
      points: drawn.points,
      yLabel: drawn.yLabel,
      empty: drawn.empty,
      notes: [...base.notes, ...drawn.notes]
    };
  }

  const kinds = kindsFor(xFamily, second && 'number');
  const chosen = request.kind && kinds.includes(request.kind)
    ? request.kind
    : preferred(kinds, first, xFamily);

  const drawn = second
    ? paired(first, second, xFamily, chosen, request.agg)
    : single(first, xFamily, chosen);
  // Bars stand in labelled slots; a histogram's bars and everything else are
  // placed on a scale, and only a scale needs a domain and ticks.
  const xNumeric = chosen !== 'bar';
  const domain = xNumeric
    ? drawn.domain ?? extent(drawn.points.map((point) => point.x))
    : undefined;

  return {
    ...splitBase,
    kinds,
    kind: chosen,
    x: first.name,
    y: second?.name,
    xLabel: first.name,
    xNumeric,
    agg: drawn.agg,
    aggs: drawn.aggs ?? [],
    seriesNames: [],
    grains,
    domain,
    ticks: domain ? axisTicks(domain, first.dtype, xFamily) : [],
    points: drawn.points,
    yLabel: drawn.yLabel,
    empty: drawn.empty,
    notes: [...base.notes, ...drawn.notes]
  };
}

/** Five values along the axis, or one where every row holds the same thing. */
function axisTicks(
  domain: [number, number],
  dtype: string,
  family: Family
): { x: number; label: string }[] {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [{ x: min, label: axisValue(min, dtype, family) }];
  return Array.from({ length: 5 }, (_, i) => {
    const x = min + ((max - min) * i) / 4;
    return { x, label: axisValue(x, dtype, family) };
  });
}

function extent(numbers: number[]): [number, number] | undefined {
  if (!numbers.length) return undefined;
  let min = numbers[0];
  let max = numbers[0];
  for (const n of numbers) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return [min, max];
}

/**
 * The head of the list, with the one exception a dtype cannot see: a numeric
 * column holding a handful of distinct values is a set of categories that
 * happen to be written as numbers — a status code, a star rating — and thirty
 * bins over five values is a comb rather than a distribution.
 */
function preferred(kinds: ChartKind[], series: Series, family: Family): ChartKind {
  if (kinds[0] !== 'histogram' || family !== 'number') return kinds[0];
  const seen = new Set<number>();
  for (const value of series.values) {
    const n = toNumber(value, family);
    if (!Number.isFinite(n)) continue;
    seen.add(n);
    if (seen.size > FEW) return 'histogram';
  }
  return seen.size ? 'bar' : 'histogram';
}

interface Drawn {
  points: ChartPoint[];
  yLabel: string;
  agg?: Agg;
  aggs?: Agg[];
  seriesNames?: string[];
  notes: string[];
  /** Set where the points do not span the axis themselves — a histogram's bins. */
  domain?: [number, number];
  empty?: string;
}

/** One column: the shape of its values, either binned or counted. */
function single(series: Series, family: Family, kind: ChartKind): Drawn {
  if (kind === 'histogram') {
    const numbers: number[] = [];
    for (const value of series.values) {
      const n = toNumber(value, family);
      if (Number.isFinite(n)) numbers.push(n);
    }
    const dropped = series.values.length - numbers.length;
    if (!numbers.length) return { points: [], yLabel: 'rows', notes: [], empty: nothing(series) };
    const binned = histogram(numbers, series.dtype, family);
    return {
      points: binned.points,
      domain: binned.domain,
      yLabel: 'rows',
      notes: dropped ? [skipped(dropped, 'no number in them')] : []
    };
  }

  const counts = new Map<string, number>();
  let blank = 0;
  for (const value of series.values) {
    if (value === null || value === undefined || value === '') { blank++; continue; }
    const label = labelOf(value, series.dtype);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!counts.size) return { points: [], yLabel: 'rows', notes: [], empty: nothing(series) };

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    points: ordered.slice(0, MAX_BARS).map(([label, count], i) => ({ x: i, y: count, label })),
    yLabel: 'rows',
    notes: [
      ...(ordered.length > MAX_BARS
        ? [`${series.name} has ${fmt(ordered.length)} distinct values; the ${MAX_BARS} most ` +
           'common are drawn.']
        : []),
      ...(blank ? [skipped(blank, 'nothing in them')] : [])
    ]
  };
}

/** Two columns: a point per row, or a bar per category with its rows averaged. */
function paired(
  first: Series,
  second: Series,
  family: Family,
  kind: ChartKind,
  wanted?: Agg
): Drawn {
  const grouped = kind === 'bar' && family === 'category';
  const points: ChartPoint[] = [];
  // The values, not a running total: a median cannot be accumulated, and the
  // array is bounded by the same maxRows the read already was.
  const groups = new Map<string, number[]>();
  let dropped = 0;

  for (let i = 0; i < first.values.length; i++) {
    const raw = first.values[i];
    const y = toNumber(second.values[i], 'number');
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(y)) {
      dropped++;
      continue;
    }
    if (grouped) {
      const label = labelOf(raw, first.dtype);
      const group = groups.get(label);
      if (group) group.push(y);
      else groups.set(label, [y]);
      continue;
    }
    const x = toNumber(raw, family);
    if (!Number.isFinite(x)) { dropped++; continue; }
    points.push({ x, y, label: labelOf(raw, first.dtype) });
  }

  const missing = dropped ? [skipped(dropped, 'a value missing from one of the two')] : [];

  if (grouped) {
    if (!groups.size) {
      return { points: [], yLabel: '', aggs: AGGS, notes: missing, empty: nothing(first) };
    }
    const agg = wanted && AGGS.includes(wanted) ? wanted : 'mean';
    const ordered = [...groups.entries()]
      .map(([label, values]) => [label, apply(agg, values), values.length] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      points: ordered.slice(0, MAX_BARS)
        .map(([label, value, n], i) => ({ x: i, y: value, label, n })),
      // Said on the axis rather than in a footnote: a bar of means and a bar of
      // totals look identical and answer different questions.
      yLabel: agg === 'count' ? 'rows' : `${agg} ${second.name}`,
      agg,
      aggs: AGGS,
      notes: [
        ...(ordered.length > MAX_BARS
          ? [`${first.name} has ${fmt(ordered.length)} distinct values; the ${MAX_BARS} with ` +
             `the highest ${agg} are drawn.`]
          : []),
        ...missing
      ]
    };
  }

  if (!points.length) {
    return { points: [], yLabel: second.name, notes: missing, empty: nothing(first) };
  }

  if (kind !== 'scatter') points.sort((a, b) => a.x - b.x);

  const cap = kind === 'scatter' ? MAX_POINTS : MAX_LINE;
  const notes = [...missing];
  let drawn = points;
  if (points.length > cap) {
    // Every nth row rather than the first n: the head of a file sorted by date
    // is one month of it, and a month captioned as the file is a lie.
    const stride = Math.ceil(points.length / cap);
    drawn = points.filter((_, i) => i % stride === 0);
    notes.push(
      `Every ${fmt(stride)} row${stride === 1 ? '' : 's'} of the ${fmt(points.length)} read ` +
      `is one of the ${fmt(drawn.length)} points drawn.`
    );
  }

  return { points: drawn, yLabel: second.name, notes };
}

/**
 * The start of the period a timestamp falls in.
 *
 * UTC throughout, because that is the clock every other date in this extension
 * is printed on — `formatValue` goes through `toISOString`, so grouping on the
 * local one would put a row in a month the panel does not show it in.
 */
export function truncate(ms: number, grain: Grain): number {
  if (grain === 'second') return Math.floor(ms / 1000) * 1000;
  if (grain === 'minute') return Math.floor(ms / 60_000) * 60_000;
  if (grain === 'hour') return Math.floor(ms / 3_600_000) * 3_600_000;

  const date = new Date(ms);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  switch (grain) {
    case 'day': return day;
    // Monday, which is the week every calendar in Europe starts on and the one
    // ISO 8601 defines. Sunday-first is a locale question this does not ask.
    case 'week': return day - ((date.getUTCDay() + 6) % 7) * 86_400_000;
    case 'month': return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    default: return Date.UTC(date.getUTCFullYear(), 0, 1);
  }
}

/**
 * The x column with every value moved to the start of its period, and printed
 * as a plain date once the period is a day or longer — `2026-03-01` says
 * "March" in a way `2026-03-01 00:00:00.000` does not.
 */
function grouped(x: Series, grain: Grain): Series {
  const coarse = grain === 'hour' || grain === 'minute' || grain === 'second';
  return {
    name: x.name,
    dtype: coarse ? x.dtype : 'date',
    values: x.values.map((value) => {
      const n = toNumber(value, 'temporal');
      return Number.isFinite(n) ? new Date(truncate(n, grain)) : null;
    })
  };
}

/**
 * One line per label, counting the rows at each point of the axis.
 *
 * The x values are kept exact while there are few enough of them to be points on
 * a line, and binned when there are not — a microsecond timestamp is its own
 * distinct value on every row, and a line of a hundred thousand ones is a fact
 * about the clock rather than about the data. Which of the two happened is said
 * on the panel, because twelve dates and thirty buckets are different charts.
 */
function split(
  x: Series,
  family: Family,
  by?: Series,
  value?: Series,
  wanted?: Agg
): Drawn {
  const agg = value ? (wanted && AGGS.includes(wanted) ? wanted : 'mean') : undefined;
  const xs: number[] = [];
  const labels: string[] = [];
  const measured: number[] = [];
  let dropped = 0;

  for (let i = 0; i < x.values.length; i++) {
    const raw = by ? by.values[i] : '';
    const n = toNumber(x.values[i], family);
    const measure = value ? toNumber(value.values[i], 'number') : 1;
    if (!Number.isFinite(n) || !Number.isFinite(measure) ||
        raw === null || raw === undefined || (by && raw === '')) {
      dropped++;
      continue;
    }
    xs.push(n);
    labels.push(by ? labelOf(raw, by.dtype) : '');
    measured.push(measure);
  }

  const missing = dropped ? [skipped(dropped, 'a value missing from one of them')] : [];
  if (!xs.length) {
    return {
      points: [], yLabel: 'rows', notes: missing,
      empty: by || value ? nothingAcross([x, value, by]) : nothing(x)
    };
  }

  // The busiest labels get the lines: six, because that is how many chart
  // colours the theme has, and a seventh line would have to repeat one.
  const totals = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = ordered.slice(0, SERIES).map(([label]) => label);
  const keeping = new Set(kept);

  const [min, max] = extent(xs) as [number, number];
  const binned = new Set(xs).size > EXACT;
  const width = (binned && (max - min) / BINS) || 0;
  const bucket = (n: number) =>
    (width ? Math.min(BINS - 1, Math.floor((n - min) / width)) : n);
  const at = (key: number) => (width ? min + width * (key + 0.5) : key);

  // The rows of each group, kept rather than tallied: what is done with them is
  // the aggregate's business, and counting is only the case with nothing to add.
  const groups = new Map<string, Map<number, number[]>>();
  for (let i = 0; i < xs.length; i++) {
    if (!keeping.has(labels[i])) continue;
    const line = groups.get(labels[i]) ?? new Map<number, number[]>();
    const key = bucket(xs[i]);
    const rows = line.get(key);
    if (rows) rows.push(measured[i]);
    else line.set(key, [measured[i]]);
    groups.set(labels[i], line);
  }

  const points: ChartPoint[] = [];
  for (const label of kept) {
    const line = [...(groups.get(label) ?? new Map<number, number[]>()).entries()]
      .sort((a, b) => a[0] - b[0]);
    for (const [key, rows] of line) {
      points.push({
        x: at(key),
        y: agg ? apply(agg, rows) : rows.length,
        // A bucket is a range, and the hover is where its edges get read.
        label: width
          ? `${axisValue(min + width * key, binDtype(x.dtype, family, width), family)} – ` +
            `${axisValue(min + width * (key + 1), binDtype(x.dtype, family, width), family)}`
          : axisValue(at(key), x.dtype, family),
        series: by ? label : undefined,
        n: rows.length
      });
    }
  }

  return {
    points,
    yLabel: !value || agg === 'count' ? 'rows' : `${agg} ${value.name}`,
    agg,
    aggs: value ? AGGS : [],
    seriesNames: by ? kept : [],
    // The buckets already end at max: running the axis a bucket further would
    // put a value on its last tick that is not in the data.
    domain: [min, max],
    notes: [
      ...(width
        ? [`${x.name} holds more distinct values than a line has points, so the rows are ` +
           `${value ? 'grouped into' : 'counted in'} ${BINS} buckets across its range ` +
           'rather than one per value.']
        : []),
      ...(by && ordered.length > SERIES
        ? [`${by.name} has ${fmt(ordered.length)} values; the ${SERIES} with the most rows ` +
           'are drawn.']
        : []),
      ...missing
    ]
  };
}

interface SplitDrawn extends Drawn {
  kind: ChartKind;
  kinds: ChartKind[];
}

/**
 * The chart, split by a third column: a line, a bar or a colour per value of it.
 *
 * Which chart that is follows from x the way the unsplit table does, with one
 * change — every kind on offer has to be able to show several series at once.
 * Bars stand side by side in their slot rather than on top of each other,
 * because a stack of means adds up to nothing; a histogram shares its bins
 * across the series so the bars of one bin are comparable; a scatter colours
 * its points and draws them as they are; a line measures each series per x.
 */
function splitChart(
  x: Series,
  family: Family,
  value: Series | undefined,
  by: Series,
  request: ChartRequest
): SplitDrawn {
  const kinds: ChartKind[] =
    family === 'category' ? ['bar']
    : family === 'number' ? (value ? ['scatter', 'line', 'bar'] : ['histogram', 'bar', 'line'])
    // Counts over time are a line per label — a histogram of dates is the same
    // line in buckets, and the period picker is the better way to ask for that.
    : value ? ['line', 'scatter', 'bar'] : ['line', 'scatter'];
  const kind = request.kind && kinds.includes(request.kind)
    ? request.kind
    : family === 'number' && !value ? preferred(kinds, x, family) : kinds[0];

  const drawn =
    kind === 'bar' ? dodged(x, family, value, by, request.agg)
    : kind === 'histogram' ? splitHistogram(x, family, by)
    : kind === 'scatter' && value ? splitScatter(x, family, value, by)
    : split(x, family, by, value, request.agg);
  return { ...drawn, kind, kinds };
}

/** A row's split label, or undefined where the row has none to give. */
function splitLabel(raw: unknown, by: Series): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  return labelOf(raw, by.dtype);
}

/**
 * Why a chart of several columns drew nothing: the column that is empty, where
 * one is — blaming x for a column of nulls in the split sends the reader to the
 * wrong select — and otherwise that no row has all of them at once.
 */
function nothingAcross(columns: (Series | undefined)[]): string {
  const present = columns.filter((column): column is Series => !!column);
  const empty = present.find((column) =>
    !column.values.some((raw) => raw !== null && raw !== undefined && raw !== ''));
  if (empty) return nothing(empty);
  return `No row read has a value in all of ${present.map((column) => column.name).join(', ')} ` +
    'at once, so there is nothing to draw.';
}

/**
 * The labels worth a series of their own: the six with the most rows, busiest
 * first, because the theme has six chart colours and a seventh line would have
 * to repeat one. Ties go alphabetically so the order — and so the colours —
 * does not move between two reads of the same file.
 */
function busiest(labels: Iterable<string>): { kept: string[]; distinct: number } {
  const totals = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { kept: ordered.slice(0, SERIES).map(([label]) => label), distinct: ordered.length };
}

function leftOut(by: Series, distinct: number): string[] {
  return distinct > SERIES
    ? [`${by.name} has ${fmt(distinct)} values; the ${SERIES} with the most rows are drawn.`]
    : [];
}

/**
 * Bars side by side: one slot per x value, one bar per series in it.
 *
 * Labels are ordered the way the unsplit bar orders them — the biggest measure
 * first, taken over every row of the slot — so splitting a chart does not
 * reshuffle it. Numbers and dates keep their own order instead, because a row
 * of months sorted by size is a puzzle rather than a timeline.
 */
function dodged(
  x: Series,
  family: Family,
  value: Series | undefined,
  by: Series,
  wanted?: Agg
): Drawn {
  const agg: Agg = value ? (wanted && AGGS.includes(wanted) ? wanted : 'mean') : 'count';
  const measure = (values: number[]) => apply(agg, values);
  const slots = new Map<string, { at: number; all: number[]; lines: Map<string, number[]> }>();
  const labels: string[] = [];
  let dropped = 0;

  for (let i = 0; i < x.values.length; i++) {
    const raw = x.values[i];
    const name = splitLabel(by.values[i], by);
    const m = value ? toNumber(value.values[i], 'number') : 1;
    const at = family === 'category' ? 0 : toNumber(raw, family);
    if (raw === null || raw === undefined || raw === '' || name === undefined ||
        !Number.isFinite(m) || !Number.isFinite(at)) {
      dropped++;
      continue;
    }
    const key = labelOf(raw, x.dtype);
    const slot = slots.get(key) ?? { at, all: [], lines: new Map<string, number[]>() };
    slot.all.push(m);
    const line = slot.lines.get(name);
    if (line) line.push(m);
    else slot.lines.set(name, [m]);
    slots.set(key, slot);
    labels.push(name);
  }

  const missing = dropped ? [skipped(dropped, 'a value missing from one of them')] : [];
  if (!slots.size) {
    return {
      points: [], yLabel: 'rows', aggs: value ? AGGS : [], notes: missing, empty: nothingAcross([x, value, by])
    };
  }

  const { kept, distinct } = busiest(labels);
  // A slot whose rows all belong to series left out has no bar to draw, and
  // counting it among the ones drawn would make the note claim bars that are
  // not there.
  const ordered = [...slots.entries()]
    .filter(([, slot]) => kept.some((name) => slot.lines.has(name)))
    .map(([label, slot]) => ({ label, slot, overall: measure(slot.all) }))
    .sort((a, b) => family === 'category'
      ? b.overall - a.overall || a.label.localeCompare(b.label)
      : a.slot.at - b.slot.at);
  const shown = ordered.slice(0, MAX_BARS);

  const points: ChartPoint[] = [];
  shown.forEach(({ label, slot }, i) => {
    for (const name of kept) {
      const rows = slot.lines.get(name);
      if (rows) points.push({ x: i, y: measure(rows), label, series: name, n: rows.length });
    }
  });

  const cut = ordered.length > MAX_BARS
    ? [family === 'category'
        ? `${x.name} has ${fmt(ordered.length)} distinct values; the ${MAX_BARS} with the ` +
          `highest ${agg === 'count' ? 'row counts' : agg} are drawn.`
        : `${x.name} has ${fmt(ordered.length)} distinct values; the first ${MAX_BARS} are ` +
          'drawn' + (family === 'temporal' ? ' — group it by a period to see all of it.' : '.')]
    : [];
  return {
    points,
    yLabel: agg === 'count' ? 'rows' : `${agg} ${value?.name ?? ''}`,
    agg: value ? agg : undefined,
    aggs: value ? AGGS : [],
    seriesNames: kept,
    notes: [...cut, ...leftOut(by, distinct), ...missing]
  };
}

/**
 * One histogram per series, over bins they share. Every bin is sent for every
 * series, zeros included: the page lays bins out by position, and a bin one
 * series skipped would shift the others' bars out from under the axis.
 */
function splitHistogram(x: Series, family: Family, by: Series): Drawn {
  const numbers: number[] = [];
  const labels: string[] = [];
  let dropped = 0;
  for (let i = 0; i < x.values.length; i++) {
    const n = toNumber(x.values[i], family);
    const name = splitLabel(by.values[i], by);
    if (!Number.isFinite(n) || name === undefined) { dropped++; continue; }
    numbers.push(n);
    labels.push(name);
  }
  const missing = dropped ? [skipped(dropped, 'a value missing from one of them')] : [];
  if (!numbers.length) {
    return { points: [], yLabel: 'rows', notes: missing, empty: nothingAcross([x, by]) };
  }

  const { kept, distinct } = busiest(labels);
  const keeping = new Set(kept);
  const drawn = numbers.filter((_, i) => keeping.has(labels[i]));
  const [min, max] = extent(drawn) as [number, number];
  const bins = min === max ? 1 : BINS;
  const width = (max - min) / bins;
  const labelled = binDtype(x.dtype, family, width);
  const counts = new Map(kept.map((name) => [name, new Array<number>(bins).fill(0)]));
  numbers.forEach((n, i) => {
    const line = counts.get(labels[i]);
    if (line) line[width ? Math.min(bins - 1, Math.floor((n - min) / width)) : 0] += 1;
  });

  const points: ChartPoint[] = [];
  for (let bin = 0; bin < bins; bin++) {
    const label = width
      ? `${axisValue(min + width * bin, labelled, family)} – ` +
        `${axisValue(min + width * (bin + 1), labelled, family)}`
      : axisValue(min, x.dtype, family);
    for (const name of kept) {
      points.push({
        x: width ? min + width * (bin + 0.5) : min,
        y: counts.get(name)![bin],
        label,
        series: name
      });
    }
  }
  return {
    points,
    domain: [min, max],
    yLabel: 'rows',
    seriesNames: kept,
    notes: [...leftOut(by, distinct), ...missing]
  };
}

/**
 * The rows themselves, coloured by series. Nothing is aggregated, so the
 * aggregate is not offered; what is capped is the number of points, taken every
 * nth row across all of them so one series is not drawn at the others' expense.
 */
function splitScatter(x: Series, family: Family, value: Series, by: Series): Drawn {
  const rows: { x: number; y: number; label: string; series: string }[] = [];
  let dropped = 0;
  for (let i = 0; i < x.values.length; i++) {
    const raw = x.values[i];
    const n = toNumber(raw, family);
    const y = toNumber(value.values[i], 'number');
    const name = splitLabel(by.values[i], by);
    if (!Number.isFinite(n) || !Number.isFinite(y) || name === undefined) { dropped++; continue; }
    rows.push({ x: n, y, label: labelOf(raw, x.dtype), series: name });
  }
  const missing = dropped ? [skipped(dropped, 'a value missing from one of them')] : [];
  if (!rows.length) {
    return { points: [], yLabel: value.name, notes: missing, empty: nothingAcross([x, value, by]) };
  }

  const { kept, distinct } = busiest(rows.map((row) => row.series));
  const keeping = new Set(kept);
  const points = rows.filter((row) => keeping.has(row.series));
  const notes = [...leftOut(by, distinct), ...missing];
  let drawn = points;
  if (points.length > MAX_POINTS) {
    const stride = Math.ceil(points.length / MAX_POINTS);
    drawn = points.filter((_, i) => i % stride === 0);
    notes.push(
      `Every ${fmt(stride)} row${stride === 1 ? '' : 's'} of the ${fmt(points.length)} read ` +
      `is one of the ${fmt(drawn.length)} points drawn.`
    );
  }
  return { points: drawn, yLabel: value.name, seriesNames: kept, notes };
}

/**
 * ISO 8601 written as text: a date, or a date and a time, with an optional zone.
 * Nothing looser — `03/04/2026` is a different day on each side of the Atlantic,
 * and a guess about which one is a guess the chart would draw as a fact.
 */
const ISO_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * An ISO date written as text, as epoch milliseconds — on UTC where it names
 * no zone, which is the clock every other date on the panel is printed on.
 * `Date.parse` reads `2026-01-01 12:00` on the local clock and `2026-01-01` on
 * UTC, and one column should not be both.
 */
export function parseIsoText(text: string): number {
  const t = text.trim();
  if (!ISO_TEXT.test(t)) return NaN;
  // A day the month does not have is not a date: Date.parse rolls 30 February
  // into March, and the chart would draw it there.
  const [year, month, day] = t.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  if (t.length === 10) return Date.parse(t);
  let iso = t.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(iso.slice(10))) iso += 'Z';
  // `+02` is how Postgres writes a zone; Date.parse wants the minutes too.
  else iso = iso.replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(iso);
}

/**
 * A text column that holds nothing but ISO dates, read as the dates it holds.
 *
 * A frame built in a notebook from literals, and a CSV read without dtype
 * inference, both carry their timestamps as strings — and a string column is a
 * row of labels, so a price over `"2023-01-01 12:00:00"` was a bar per
 * timestamp rather than a line over time. Every non-empty value has to be one,
 * or the column is left as the labels it says it is.
 */
export function textDates(series: Series): Series {
  const dtype = series.dtype.trim().toLowerCase();
  if (dtype && !/^(str|utf8|string)/.test(dtype)) return series;
  // Every value, not a sample: one "unknown" after the first few hundred would
  // otherwise become a null the chart then counts as a row with nothing in it.
  const values: (Date | null)[] = [];
  let seen = false;
  let dateOnly = true;
  for (const value of series.values) {
    if (value === null || value === undefined || value === '') { values.push(null); continue; }
    const ms = typeof value === 'string' ? parseIsoText(value) : NaN;
    if (!Number.isFinite(ms)) return series;
    if ((value as string).trim().length !== 10) dateOnly = false;
    seen = true;
    values.push(new Date(ms));
  }
  if (!seen) return series;
  return { name: series.name, dtype: dateOnly ? 'date' : 'datetime[ms]', values };
}

/**
 * One group's rows, measured. Reductions rather than `Math.min(...values)`,
 * because a group can hold more values than an argument list can.
 */
function apply(agg: Agg, values: number[]): number {
  switch (agg) {
    case 'count': return values.length;
    case 'sum': return values.reduce((total, n) => total + n, 0);
    case 'mean': return values.reduce((total, n) => total + n, 0) / values.length;
    case 'min': return values.reduce((low, n) => (n < low ? n : low));
    case 'max': return values.reduce((high, n) => (n > high ? n : high));
    default: {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
}

/**
 * Equal-width bins over the range the values actually cover. The points are the
 * bin midpoints and the domain is the outer edges, because an axis that stops
 * at the middle of the last bar is an axis that lies about the largest value.
 */
function histogram(
  numbers: number[],
  dtype: string,
  family: Family
): { points: ChartPoint[]; domain: [number, number] } {
  const [min, max] = extent(numbers) as [number, number];
  if (min === max) {
    return {
      points: [{ x: min, y: numbers.length, label: axisValue(min, dtype, family) }],
      domain: [min, max]
    };
  }

  const width = (max - min) / BINS;
  dtype = binDtype(dtype, family, width);
  const counts = new Array<number>(BINS).fill(0);
  for (const n of numbers) {
    counts[Math.min(BINS - 1, Math.floor((n - min) / width))] += 1;
  }
  return {
    points: counts.map((count, i) => ({
      x: min + width * (i + 0.5),
      y: count,
      label: `${axisValue(min + width * i, dtype, family)} – ` +
        `${axisValue(min + width * (i + 1), dtype, family)}`
    })),
    domain: [min, max]
  };
}

/**
 * A value as a number the chart can place. Dates are their epoch milliseconds,
 * which is what makes a time axis an axis rather than a row of labels — and a
 * CSV's strings are parsed here rather than by the reader, because only the
 * chart knows it wanted a number.
 */
export function toNumber(value: unknown, family: Family): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    // Number('') is 0 and so is Number('  '), which is how a column of blanks
    // becomes a spike at zero. This check is what stops that.
    if (!text) return NaN;
    if (family === 'temporal') {
      const iso = parseIsoText(text);
      if (Number.isFinite(iso)) return iso;
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return Number(text);
  }
  return NaN;
}

/** A value as it will be read: the formatter the grid and the hover already share. */
function labelOf(value: unknown, dtype: string): string {
  const label = formatValue(value, dtype, { maxLength: 28 }) ?? 'null';
  return value instanceof Date ? wholeSeconds(label) : label;
}

/**
 * `12:00:00.000` is `12:00:00`: milliseconds are printed only where there are
 * some. The grid keeps them, since it lines values up; a chart's label and its
 * hover are read one at a time, and three zeros are only noise there.
 */
function wholeSeconds(label: string): string {
  return label.replace(/(\d{2}:\d{2}:\d{2})\.000$/, '$1');
}

/**
 * The dtype a bin's edges are printed in. A bin of a date column narrower than
 * a day has edges inside a day, and printing them as dates labels three bins
 * `2026-01-01 – 2026-01-01`; the time of day is what tells them apart.
 */
function binDtype(dtype: string, family: Family, width: number): string {
  return family === 'temporal' && dtype === 'date' && width > 0 && width < 86_400_000
    ? 'datetime[ms]'
    : dtype;
}

/** A number on an axis: a date where the column is one, four digits otherwise. */
function axisValue(n: number, dtype: string, family: Family): string {
  if (family === 'temporal') {
    return wholeSeconds(formatValue(new Date(n), dtype, { maxLength: 28 }) ?? '');
  }
  return String(Number(n.toPrecision(4)));
}

function readNotes(read: SeriesRead): string[] {
  if (read.prefixBytes !== undefined) {
    return [
      `This is a CSV, so these numbers come from the first ${fmt(read.prefixBytes)} bytes of ` +
      'the file rather than from all of it — a prefix, not the file.'
    ];
  }
  if (!read.complete) {
    return [
      `Read the first ${fmt(read.rowsRead)} rows` +
      (read.rowCount ? ` of ${fmt(read.rowCount)}` : '') +
      ': this is a sample of the file rather than the file. ' +
      'polarsense.graph.maxRows is the limit.'
    ];
  }
  return [];
}

function skipped(rows: number, why: string): string {
  return `${fmt(rows)} row${rows === 1 ? '' : 's'} skipped: ${why}.`;
}

function nothing(series: Series): string {
  return `${series.name} has nothing in it to draw — every row read was null or empty.`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
