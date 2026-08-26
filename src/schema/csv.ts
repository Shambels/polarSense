import type { Column, SourceRef } from '../core/types.js';
import { readHead } from '../storage/local.js';
import { readHeadHttps } from '../storage/https.js';
import { schemeOf } from '../storage/index.js';

export interface CsvOptions {
  sniffBytes: number;
  inferDtypes: boolean;
}

/**
 * CSV has no embedded schema, so the header row *is* the schema — read with the
 * same options the call site passed to polars, or the header is wrong in exactly
 * the way that is most confusing.
 */
export async function readCsvSchema(
  uri: string,
  kwargs: SourceRef['kwargs'],
  options: CsvOptions
): Promise<Column[]> {
  const { text } = await readCsvPrefix(uri, options.sniffBytes);
  // Dtypes are guessed from the first rows or not at all, so nothing but the
  // header is split when the guess is switched off.
  const { names, records } = csvTable(text, kwargs, { start: 0, limit: options.inferDtypes ? 50 : 0 });
  if (!options.inferDtypes) return names.map((name) => ({ name, dtype: '' }));
  return names.map((name, i) => ({ name, dtype: inferDtype(records.map((r) => r[i])) }));
}

/**
 * The bounded prefix both the header read and the row preview work from, and
 * whether it stopped short of the end of the file — which is the difference
 * between "this is the file" and "this is as much of it as we read".
 */
export async function readCsvPrefix(
  uri: string,
  sniffBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const scheme = schemeOf(uri);
  const bytes = scheme === 'file'
    ? await readHead(uri, sniffBytes)
    : await readHeadHttps(uri, sniffBytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  return {
    text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    truncated: bytes.length >= sniffBytes
  };
}

export interface CsvWindow {
  /** First data record to return, counting from the first row after the header. */
  start: number;
  limit: number;
}

export interface CsvTable {
  names: string[];
  records: string[][];
  /** A record was found past the window — there is a next page inside this text. */
  more: boolean;
}

/**
 * The header and a window of data records, read the way the call site asked for
 * them: `separator=`, `quote_char=`, `comment_prefix=`, `skip_rows=`,
 * `has_header=` and `new_columns=` all change what the same bytes mean.
 *
 * The window is what keeps this honest about cost. The caller has a bounded
 * prefix of the file and wants one page out of it; splitting the rest of the
 * text into fields is work nobody asked for.
 */
export function csvTable(
  text: string,
  kwargs: SourceRef['kwargs'],
  window: CsvWindow
): CsvTable {
  const separator = typeof kwargs.separator === 'string' && kwargs.separator.length
    ? kwargs.separator
    : ',';
  const quoteChar = typeof kwargs.quote_char === 'string' && kwargs.quote_char.length
    ? kwargs.quote_char
    : '"';
  const commentPrefix = typeof kwargs.comment_prefix === 'string' ? kwargs.comment_prefix : null;
  const hasHeader = kwargs.has_header !== false;
  const skipRows = typeof kwargs.skip_rows === 'number' ? kwargs.skip_rows : 0;

  const rows = splitRows(text, quoteChar);
  let index = skipRows;
  if (commentPrefix) {
    while (index < rows.length && rows[index].startsWith(commentPrefix)) index++;
  }
  while (index < rows.length && rows[index].trim() === '') index++;
  const headerRow = rows[index];
  if (headerRow === undefined) return { names: [], records: [], more: false };

  const fields = splitFields(headerRow, separator, quoteChar);
  const names = Array.isArray(kwargs.new_columns) && kwargs.new_columns.length
    // `new_columns=` overrides whatever is in the file.
    ? kwargs.new_columns.map(String)
    : hasHeader
      ? fields.map((f, i) => (f.trim() === '' ? `column_${i + 1}` : f.trim()))
      : fields.map((_, i) => `column_${i + 1}`);

  const records: string[][] = [];
  let seen = 0;
  let more = false;
  for (let row = index + (hasHeader ? 1 : 0); row < rows.length; row++) {
    if (rows[row].trim() === '') continue;
    if (commentPrefix && rows[row].startsWith(commentPrefix)) continue;
    if (seen++ < window.start) continue;
    if (records.length >= window.limit) { more = true; break; }
    records.push(splitFields(rows[row], separator, quoteChar));
  }

  return { names, records, more };
}

/** Split on newlines that are not inside a quoted field. */
export function splitRows(text: string, quote: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) { current += quote; i++; continue; }
        inQuotes = false;
        current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === quote) { inQuotes = true; current += ch; continue; }
    if (ch === '\n') { rows.push(current.replace(/\r$/, '')); current = ''; continue; }
    current += ch;
  }
  if (current) rows.push(current.replace(/\r$/, ''));
  return rows;
}

export function splitFields(row: string, separator: string, quote: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === quote) {
        if (row[i + 1] === quote) { current += quote; i++; continue; }
        inQuotes = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === quote && current === '') { inQuotes = true; continue; }
    if (row.startsWith(separator, i) && separator.length) {
      fields.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function inferDtype(values: (string | undefined)[]): string {
  const present = values.filter((v): v is string => v !== undefined && v.trim() !== '');
  if (!present.length) return '';
  if (present.every((v) => /^-?\d+$/.test(v))) return 'i64';
  if (present.every((v) => /^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(v))) return 'f64';
  if (present.every((v) => /^(true|false)$/i.test(v))) return 'bool';
  if (present.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date';
  if (present.every((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) return 'datetime[μs]';
  return 'str';
}
