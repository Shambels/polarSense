/**
 * One value, as it will be printed. Shared by the statistics in a parquet footer
 * and the cells of a previewed page, because they are the same problem: hyparquet
 * hands back whatever the file holds, and only the dtype says what it means.
 */

export interface FormatOptions {
  /** Beyond this many characters a value is cut short with an ellipsis. */
  maxLength?: number;
}

/**
 * hyparquet decodes DATE and TIMESTAMP into Date objects, but other writers emit
 * the raw integer — days or micros since the epoch — which reads as a meaningless
 * number unless the dtype is applied. Handle both.
 *
 * Null comes back as null rather than the string "null": a cell that is empty and
 * a cell holding the four letters n-u-l-l are different, and only the caller
 * knows how to show the difference.
 */
export function formatValue(
  value: unknown,
  dtype: string,
  options: FormatOptions = {}
): string | null {
  const maxLength = options.maxLength ?? 40;
  if (value === null || value === undefined) return null;

  if (value instanceof Uint8Array) return '…';

  if (value instanceof Date) {
    const iso = value.toISOString();
    return dtype === 'date' ? iso.slice(0, 10) : iso.replace('T', ' ').replace('Z', '').slice(0, 23);
  }
  if (dtype === 'date' && (typeof value === 'number' || typeof value === 'bigint')) {
    return new Date(Number(value) * 86_400_000).toISOString().slice(0, 10);
  }
  if (dtype.startsWith('datetime') && (typeof value === 'number' || typeof value === 'bigint')) {
    const n = Number(value);
    const ms = dtype.includes('[ms') ? n : dtype.includes('[ns') ? n / 1e6 : n / 1000;
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  }

  // A duration is a magnitude of time, and reads as one — the largest two units
  // that carry it — rather than as the raw count of microseconds the file holds.
  // The unit is read from the dtype so `duration[ns]` and `duration[μs]` both
  // come out right; the kernel path hands them over already in microseconds.
  if (dtype.toLowerCase().startsWith('duration') && (typeof value === 'number' || typeof value === 'bigint')) {
    return durationSpan(Number(value), dtype);
  }

  // A list or a struct arrives as an array or a plain object. `String()` turns
  // the first into "1,2" and the second into "[object Object]", so neither is
  // recognisable as what it is; JSON at least keeps the shape.
  if (typeof value === 'object') return truncate(json(value), maxLength);

  return truncate(String(value), maxLength);
}

/** Microseconds per unit, and how a duration dtype's own unit scales to them. */
const MICROS: Record<string, number> = { ns: 1 / 1000, us: 1, 'μs': 1, ms: 1000, s: 1_000_000 };
const SPAN: [string, number][] = [
  ['d', 86_400_000_000], ['h', 3_600_000_000], ['m', 60_000_000],
  ['s', 1_000_000], ['ms', 1_000], ['µs', 1]
];

/**
 * A duration as a short human span — `13d 19h`, `15m`, `500µs` — from a value in
 * the dtype's own unit. Two components at most: an axis tick wants the shape of
 * the number, not every digit of it.
 */
export function durationSpan(value: number, dtype: string): string {
  if (!Number.isFinite(value)) return String(value);
  const unit = /\[\s*(ns|us|μs|ms|s)/.exec(dtype.toLowerCase());
  const micros = value * (unit ? MICROS[unit[1]] : 1);
  const sign = micros < 0 ? '-' : '';
  let n = Math.round(Math.abs(micros));
  if (n === 0) return '0s';
  let start = SPAN.findIndex(([, size]) => n >= size);
  if (start === -1) start = SPAN.length - 1;
  const parts: string[] = [];
  for (let i = start; i < SPAN.length && parts.length < 2; i++) {
    const v = Math.floor(n / SPAN[i][1]);
    n -= v * SPAN[i][1];
    if (v > 0) parts.push(v + SPAN[i][0]);
  }
  return sign + parts.join(' ');
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** BigInt has no JSON representation, and a page of int64s is full of them. */
function json(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? String(item) : item instanceof Uint8Array ? '…' : item
    ) ?? '';
  } catch {
    return String(value);
  }
}
