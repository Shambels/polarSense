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
  const scheme = schemeOf(uri);
  const bytes = scheme === 'file'
    ? await readHead(uri, options.sniffBytes)
    : await readHeadHttps(uri, options.sniffBytes);

  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

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
  if (headerRow === undefined) return [];

  const fields = splitFields(headerRow, separator, quoteChar);

  // `new_columns=` overrides whatever is in the file.
  if (Array.isArray(kwargs.new_columns) && kwargs.new_columns.length) {
    return kwargs.new_columns.map((name) => ({ name, dtype: '' }));
  }

  const names = hasHeader
    ? fields.map((f, i) => (f.trim() === '' ? `column_${i + 1}` : f.trim()))
    : fields.map((_, i) => `column_${i + 1}`);

  if (!options.inferDtypes) return names.map((name) => ({ name, dtype: '' }));

  const sample = rows.slice(index + (hasHeader ? 1 : 0), index + 51)
    .filter((r) => r.trim() !== '')
    .map((r) => splitFields(r, separator, quoteChar));
  return names.map((name, i) => ({ name, dtype: inferDtype(sample.map((r) => r[i])) }));
}

/** Split on newlines that are not inside a quoted field. */
function splitRows(text: string, quote: string): string[] {
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

function splitFields(row: string, separator: string, quote: string): string[] {
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
