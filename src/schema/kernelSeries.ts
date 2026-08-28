import type { Series, SeriesRead } from './series.js';

/**
 * The one place PolarSense reaches past a file into a running kernel, kept pure
 * so it can be tested without one: it writes the Python that fetches a frame's
 * values and parses what comes back. The `vscode`/Jupyter wiring that actually
 * runs it lives in `../preview/kernel.ts`; everything decidable from a string
 * lives here.
 *
 * The contract with the snippet is a single line of stdout wrapped in a
 * sentinel — `__POLARSENSE__{…json…}__POLARSENSE__` — so a stray warning or a
 * `collect()` progress line printed alongside it does not get mistaken for the
 * answer. The JSON is `write_json`'s spirit, not its letter: columns typed into
 * the families the chart already knows, because the chart draws a magnitude, a
 * label or a point in time and nothing finer.
 */

/** Which frame the kernel should hand back, and how it is addressed. */
export interface KernelTarget {
  /**
   * IPython's output-history key — the cell's execution count. Tried first
   * because `_oh[n]` is the frame the cell already computed and printed: reading
   * it re-runs nothing and re-reads nothing. Absent where the cell has not run.
   */
  outputRef?: number;
  /**
   * The variable the frame is bound to, collected if it is a `LazyFrame`. The
   * case worth supporting properly, per the roadmap; tried when `_oh` misses.
   */
  symbol?: string;
}

/** The sentinel the snippet prints its JSON between. Also the marker we parse on. */
export const MARKER = '__POLARSENSE__';

/** A column name is only used as a lookup key, never interpolated raw into code. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The read-only Python that fetches `columns` (capped at `maxRows`) from the
 * addressed frame and prints them as one sentinel-wrapped JSON line.
 *
 * It defines and calls one function so nothing it does leaks into the user's
 * namespace, touches no `_i`/`_` history, and rebinds no variable. Every step
 * that can fail on a frame that is not what we assumed — no polars, a lazy frame
 * that will not collect, a target that is not a frame — returns a named error
 * rather than raising, so the host can fall back to the file quietly.
 */
export function chartFetchSnippet(
  target: KernelTarget,
  columns: string[],
  maxRows: number
): string {
  const cols = JSON.stringify(JSON.stringify(columns));
  const n = Math.max(1, Math.floor(maxRows) || 1);
  const ref = typeof target.outputRef === 'number' && Number.isInteger(target.outputRef)
    ? String(target.outputRef)
    : 'None';
  const sym = target.symbol && IDENT.test(target.symbol)
    ? JSON.stringify(target.symbol)
    : 'None';

  // Kept deliberately flat and defensive: it runs in someone else's session and
  // must never raise, because a traceback is a worse answer than the file.
  return [
    'import json as _ps_json',
    'def _ps_fetch():',
    '    try:',
    '        import polars as _ps_pl',
    '    except Exception:',
    '        return {"error": "no-polars"}',
    `    _cols = _ps_json.loads(${cols})`,
    `    _n = ${n}`,
    '    _tgt = None',
    '    _oh = globals().get("_oh") or {}',
    `    _ref = ${ref}`,
    '    if _ref is not None:',
    '        try:',
    '            _tgt = _oh.get(_ref)',
    '        except Exception:',
    '            _tgt = None',
    '    if _tgt is None:',
    `        _sym = ${sym}`,
    '        if _sym is not None:',
    '            _tgt = globals().get(_sym)',
    '    if _tgt is None:',
    '        return {"error": "no-target"}',
    '    _df = _tgt',
    '    if isinstance(_df, _ps_pl.LazyFrame):',
    '        try:',
    '            _df = _df.collect()',
    '        except Exception:',
    '            return {"error": "collect-failed"}',
    '    if not isinstance(_df, _ps_pl.DataFrame):',
    '        return {"error": "not-a-frame"}',
    '    _total = int(_df.height)',
    '    _have = [c for c in _cols if c in _df.columns]',
    '    _df = _df.select(_have) if _have else _df.head(0)',
    '    if _total > _n:',
    '        _df = _df.head(_n)',
    '    _out = []',
    '    for _name in _df.columns:',
    '        _s = _df.get_column(_name)',
    '        _dt = _s.dtype',
    '        _family = "category"',
    '        try:',
    '            if _dt == _ps_pl.Duration:',
    // A duration is a magnitude, not a point on a calendar: microseconds, so it
    // can be summed and averaged like the number it is — and its own family, so
    // the axis reads it back as a span of time rather than a count of them.
    '                _family = "duration"',
    '                _vals = _s.dt.total_microseconds().to_list()',
    '            elif _dt in (_ps_pl.Datetime, _ps_pl.Date, _ps_pl.Time):',
    '                try:',
    '                    _vals = _s.cast(_ps_pl.Datetime("ms")).cast(_ps_pl.Int64).to_list()',
    '                    _family = "temporal"',
    '                except Exception:',
    '                    _vals = [None if _v is None else str(_v) for _v in _s.to_list()]',
    '                    _family = "category"',
    '            elif _dt.is_numeric():',
    '                _family = "number"',
    '                _vals = _s.to_list()',
    '            else:',
    '                _vals = [None if _v is None else str(_v) for _v in _s.to_list()]',
    '        except Exception:',
    '            _family = "category"',
    '            _vals = [None if _v is None else str(_v) for _v in _s.to_list()]',
    '        _out.append({"name": _name, "family": _family, "values": _vals})',
    '    return {"columns": _out, "rowCount": _total, "complete": _total <= _n}',
    `print(${JSON.stringify(MARKER)} + _ps_json.dumps(_ps_fetch(), default=str) + ${JSON.stringify(MARKER)})`
  ].join('\n');
}

/** What a family reported by the snippet means to the chart's dtype-driven code. */
const DTYPE: Record<string, string> = {
  number: 'f64',
  // A duration keeps a duration dtype so the chart measures it as a magnitude
  // and the axis formats it as a span; the values are already microseconds.
  duration: 'duration[μs]',
  temporal: 'datetime[ms]',
  category: 'str'
};

interface RawColumn {
  name: unknown;
  family: unknown;
  values: unknown;
}

export type KernelParse = { read: SeriesRead } | { error: string };

/**
 * The kernel's stdout, turned into the same `SeriesRead` the file readers hand
 * `buildChart`. Anything that is not the shape we asked for — no sentinel, no
 * JSON, an error field, a columns array that is not one — is an error the caller
 * treats as "the kernel could not answer", never a throw.
 */
export function parseChartJson(text: string): KernelParse {
  const start = text.indexOf(MARKER);
  const end = text.lastIndexOf(MARKER);
  if (start === -1 || end <= start) return { error: 'no-output' };
  const json = text.slice(start + MARKER.length, end);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'bad-json' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'bad-json' };

  const record = parsed as Record<string, unknown>;
  if (typeof record.error === 'string') return { error: record.error };
  if (!Array.isArray(record.columns)) return { error: 'no-columns' };

  const series: Series[] = [];
  for (const raw of record.columns as RawColumn[]) {
    if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.values)) {
      return { error: 'bad-column' };
    }
    const family = typeof raw.family === 'string' ? raw.family : 'category';
    series.push({
      name: raw.name,
      dtype: DTYPE[family] ?? 'str',
      // Null stays null; the chart's own reducers know to skip it. Everything
      // else arrives as the JSON primitive the family promised.
      values: raw.values.map((value) => (value === undefined ? null : value))
    });
  }

  const rowsRead = series[0]?.values.length ?? 0;
  const rowCount = typeof record.rowCount === 'number' ? record.rowCount : undefined;
  return {
    read: {
      series,
      rowsRead,
      rowCount,
      // Absent or non-boolean is treated as "not known to be whole", so a chart
      // is captioned a sample rather than silently claimed as the frame.
      complete: record.complete === true
    }
  };
}
