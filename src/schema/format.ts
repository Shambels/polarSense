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

  // A list or a struct arrives as an array or a plain object. `String()` turns
  // the first into "1,2" and the second into "[object Object]", so neither is
  // recognisable as what it is; JSON at least keeps the shape.
  if (typeof value === 'object') return truncate(json(value), maxLength);

  return truncate(String(value), maxLength);
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
