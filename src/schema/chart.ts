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

/** The dtype families that behave differently when drawn, and nothing finer. */
export type Family = 'number' | 'temporal' | 'category' | 'nested';

export interface ChartRequest {
  /** The column on the x axis. */
  x: string;
  /** The second column, when there is one. */
  y?: string;
  /** The user's override, when they made one. Absent means the table decides. */
  kind?: ChartKind;
  maxRows: number;
}

/** One mark. Numbers only — a label is what it is called, never what it is. */
export interface ChartPoint {
  x: number;
  y: number;
  label: string;
}

export interface Chart {
  kind: ChartKind;
  /** The kinds these columns can be drawn as, best first: the override's list. */
  kinds: ChartKind[];
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
    if (/^(date|time|duration|timestamp)/.test(d)) return 'temporal';
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
 * The read, turned into the few hundred numbers the page draws.
 *
 * Everything expensive has already happened by the time this is called: this is
 * arithmetic over arrays that are in memory, which is why it is pure and can be
 * tested against a column of values rather than against a file.
 */
export function buildChart(read: SeriesRead, request: ChartRequest): Chart {
  const xSeries = read.series.find((series) => series.name === request.x);
  const ySeries = request.y ? read.series.find((series) => series.name === request.y) : undefined;

  const base = {
    kinds: [] as ChartKind[],
    x: request.x,
    y: request.y,
    xLabel: request.x,
    yLabel: '',
    xNumeric: false,
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
  let first = xSeries;
  let second = ySeries;
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
  if (second && yFamily !== 'number') {
    // Two label columns is a cross-tabulation, which is a table and not a chart.
    return {
      ...base,
      kind: 'bar',
      empty: `${second.name} holds labels rather than numbers, so there is nothing to ` +
        `measure against ${first.name}. Drop the second column to count them instead.`
    };
  }

  const kinds = kindsFor(xFamily, second && 'number');
  const chosen = request.kind && kinds.includes(request.kind)
    ? request.kind
    : preferred(kinds, first, xFamily);

  const drawn = second ? paired(first, second, xFamily, chosen) : single(first, xFamily, chosen);
  // Bars stand in labelled slots; a histogram's bars and everything else are
  // placed on a scale, and only a scale needs a domain and ticks.
  const xNumeric = chosen !== 'bar';
  const domain = xNumeric
    ? drawn.domain ?? extent(drawn.points.map((point) => point.x))
    : undefined;

  return {
    ...base,
    kinds,
    kind: chosen,
    x: first.name,
    y: second?.name,
    xLabel: first.name,
    xNumeric,
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
function paired(first: Series, second: Series, family: Family, kind: ChartKind): Drawn {
  const grouped = kind === 'bar' && family === 'category';
  const points: ChartPoint[] = [];
  const groups = new Map<string, { total: number; rows: number }>();
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
      const group = groups.get(label) ?? { total: 0, rows: 0 };
      group.total += y;
      group.rows += 1;
      groups.set(label, group);
      continue;
    }
    const x = toNumber(raw, family);
    if (!Number.isFinite(x)) { dropped++; continue; }
    points.push({ x, y, label: labelOf(raw, first.dtype) });
  }

  const missing = dropped ? [skipped(dropped, 'a value missing from one of the two')] : [];

  if (grouped) {
    if (!groups.size) return { points: [], yLabel: '', notes: missing, empty: nothing(first) };
    const ordered = [...groups.entries()]
      .sort((a, b) => b[1].total / b[1].rows - a[1].total / a[1].rows || a[0].localeCompare(b[0]));
    return {
      points: ordered
        .slice(0, MAX_BARS)
        .map(([label, group], i) => ({ x: i, y: group.total / group.rows, label })),
      // Said on the axis rather than in a footnote: a bar of means and a bar of
      // totals look identical and answer different questions.
      yLabel: `mean ${second.name}`,
      notes: [
        ...(ordered.length > MAX_BARS
          ? [`${first.name} has ${fmt(ordered.length)} distinct values; the ${MAX_BARS} with ` +
             'the highest mean are drawn.']
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
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return Number(text);
  }
  return NaN;
}

/** A value as it will be read: the formatter the grid and the hover already share. */
function labelOf(value: unknown, dtype: string): string {
  return formatValue(value, dtype, { maxLength: 28 }) ?? 'null';
}

/** A number on an axis: a date where the column is one, four digits otherwise. */
function axisValue(n: number, dtype: string, family: Family): string {
  if (family === 'temporal') return formatValue(new Date(n), dtype, { maxLength: 28 }) ?? '';
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
