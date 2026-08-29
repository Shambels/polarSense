import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { SourceRef } from '../core/types.js';
import type { Storage } from '../storage/index.js';
import { COMPRESSORS } from './compressors.js';
import { parquetDtype, type ParquetNode } from './dtypes.js';
import { formatValue } from './format.js';
import { csvTable, readCsvPrefix } from './csv.js';

/**
 * A page of a file, and nothing either side of it.
 *
 * This is the one shape the preview is built on, and the reason it can be built
 * at all: parquet stores columns independently and records where each row group
 * starts, so "rows 5,000 to 5,100 of these four columns" is a handful of range
 * reads whatever the file weighs. Nothing here reads a file end to end.
 */
export interface RowPage {
  /** The columns read, in the order the cells of each row come in. */
  columns: string[];
  dtypes: string[];
  /** Cells, already formatted for display. Null is a null, not an empty string. */
  rows: (string | null)[][];
  /** Every column the file has — so a viewer can offer the ones it is not drawing. */
  allColumns: string[];
  rowStart: number;
  /** Rows in the file, when the format records it. */
  rowCount?: number;
  /** There are rows after this page that this reader can reach. */
  more: boolean;
  /**
   * Set when the rows could only be read from a bounded prefix of the file, and
   * says how many bytes that was. A pager must not offer what it cannot fetch,
   * and a panel must not call a prefix the file.
   */
  prefixBytes?: number;
  /**
   * How many rows the ordering was computed over, when the page was sorted.
   * Below the file's own row count it means the sort saw a window rather than
   * the file, and the top of that window is not the top of the file — which is
   * the one thing a sorted page must not let anyone assume.
   */
  sortedRows?: number;
}

export interface RowRequest {
  /** Names to read; the file's own order is used for anything not listed. */
  columns?: string[];
  rowStart: number;
  /** How many rows to return. The page is the unit of both reading and drawing. */
  limit: number;
  /**
   * Order the rows by one column before paging them.
   *
   * This is the one request that breaks the page-is-the-read rule, and it has to:
   * row 0 of a sorted file is not a row you can seek to, so the rows have to be
   * in hand before the first one is known. `maxRows` is the ceiling on how many
   * are read to find them, and `RowPage.sortedRows` says how many that was.
   */
  sort?: { column: string; desc: boolean; maxRows: number };
}

/** Columns drawn when the caller does not say — a wide file is not a wall of text. */
export const DEFAULT_COLUMNS = 40;

export async function readParquetRows(
  storage: Storage,
  uri: string,
  request: RowRequest
): Promise<RowPage> {
  const buffer = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(buffer);
  const rowCount = Number(metadata.num_rows ?? 0);
  const schema = parquetSchema(metadata) as unknown as ParquetNode;
  const all = schema.children.map((child) => ({
    name: child.element.name,
    dtype: parquetDtype(child)
  }));

  const wanted = pick(all.map((column) => column.name), request.columns);
  const dtypes = wanted.map((name) => all.find((c) => c.name === name)?.dtype ?? '');

  const rowStart = Math.max(0, Math.min(request.rowStart, Math.max(0, rowCount - 1)));
  const rowEnd = Math.min(rowCount, rowStart + Math.max(1, request.limit));

  const page = {
    columns: wanted,
    dtypes,
    allColumns: all.map((column) => column.name),
    rowStart,
    rowCount,
    more: rowEnd < rowCount
  };
  if (!wanted.length || rowEnd <= rowStart) return { ...page, rows: [] };

  const format = (object: Record<string, unknown>) =>
    wanted.map((name, i) => formatValue(object[name], dtypes[i], { maxLength: 60 }));

  const sort = request.sort && all.some((c) => c.name === request.sort?.column)
    ? request.sort
    : undefined;
  if (sort) {
    // Sorting is a window read, not a page read. The rows have to exist before
    // the order does, so this reads up to `maxRows` of them — still only the
    // columns being drawn, plus the one being sorted by.
    const window = Math.min(rowCount, Math.max(1, sort.maxRows));
    const columns = wanted.includes(sort.column) ? wanted : [...wanted, sort.column];
    const objects = await parquetReadObjects({
      file: buffer,
      metadata,
      columns,
      compressors: COMPRESSORS,
      rowStart: 0,
      rowEnd: window
    });
    objects.sort(byKey((object) => object[sort.column], sort.desc));

    const start = Math.min(rowStart, Math.max(0, objects.length - 1));
    const rows = objects.slice(start, start + Math.max(1, request.limit));
    return {
      ...page,
      rowStart: start,
      more: start + rows.length < objects.length,
      sortedRows: objects.length,
      rows: rows.map(format)
    };
  }

  // Only the columns being drawn are decoded. On a 200-column file that is the
  // difference between reading four column chunks and reading the file.
  const objects = await parquetReadObjects({
    file: buffer,
    metadata,
    columns: wanted,
    compressors: COMPRESSORS,
    rowStart,
    rowEnd
  });

  return { ...page, rows: objects.map(format) };
}

/**
 * CSV has no footer, so there is no row count to know and no offset to seek to:
 * a page is whatever is in the prefix that was already read to find the header.
 * That is a real limit rather than a temporary one — reaching row 5,000,000 of a
 * CSV means walking the 4,999,999 before it — so the page says how much it read
 * and the caller says so on screen.
 */
export async function readCsvRows(
  uri: string,
  kwargs: SourceRef['kwargs'],
  options: { sniffBytes: number },
  request: RowRequest
): Promise<RowPage> {
  const { text, truncated } = await readCsvPrefix(uri, options.sniffBytes);
  const rowStart = Math.max(0, request.rowStart);
  const limit = Math.max(1, request.limit);
  // Sorted, the page is a slice of an order, so every row the prefix holds has
  // to be parsed before the first one is known.
  const sort = request.sort;
  const table = csvTable(text, kwargs, sort
    ? { start: 0, limit: Math.max(1, sort.maxRows) }
    : { start: rowStart, limit });

  const records = [...table.records];
  let more = table.more;
  // The read stopped mid-line, so the last record in a truncated prefix is half
  // a row. A cut-off value shown as data is worse than a row that is not shown.
  if (truncated && !more && records.length) records.pop();

  const wanted = pick(table.names, request.columns);
  const indices = wanted.map((name) => table.names.indexOf(name));
  const cells = (record: string[]) => indices.map((i) => record[i] ?? '');
  const page = {
    columns: wanted,
    dtypes: wanted.map(() => ''),
    allColumns: table.names,
    rowCount: undefined,
    prefixBytes: truncated ? options.sniffBytes : undefined
  };

  const key = sort ? table.names.indexOf(sort.column) : -1;
  if (sort && key !== -1) {
    records.sort(byKey((record) => record[key], sort.desc));
    const start = Math.min(rowStart, Math.max(0, records.length - 1));
    const rows = records.slice(start, start + limit);
    return {
      ...page,
      rowStart: start,
      more: start + rows.length < records.length,
      sortedRows: records.length,
      rows: rows.map(cells)
    };
  }

  return { ...page, rowStart, more, rows: records.map(cells) };
}

const empty = (value: unknown): boolean =>
  value === null || value === undefined || value === '';

/** `<` and `>` on two values of the same kind, whatever kind that turns out to be. */
function order(x: unknown, y: unknown): number {
  const a = x as number;
  const b = y as number;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order rows by one of their values. */
function byKey<T>(get: (row: T) => unknown, desc: boolean): (a: T, b: T) => number {
  const dir = desc ? -1 : 1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    // Nulls last in both directions. An empty cell is not the smallest value,
    // it is the absence of one — and sorting by a column is asking to see the
    // values in it, not the rows that have none.
    if (empty(x)) return empty(y) ? 0 : 1;
    if (empty(y)) return -1;

    // A CSV has no dtypes, so a column of numbers arrives as strings and would
    // put "10" above "9" — which reads as a broken sort rather than as a
    // missing dtype.
    if (typeof x === 'string' && typeof y === 'string') {
      const nx = Number(x);
      const ny = Number(y);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return dir * order(nx, ny);
    }

    // Numbers, bigints and dates compare as themselves. A list or a struct has
    // no order of its own, so its printed form is the only one there is.
    const comparable = typeof x === typeof y
      && (typeof x !== 'object' || (x instanceof Date && y instanceof Date));
    return dir * (comparable ? order(x, y) : order(String(x), String(y)));
  };
}

/** The columns asked for that the file actually has, or its first few. */
function pick(all: string[], wanted?: string[]): string[] {
  if (!wanted?.length) return all.slice(0, DEFAULT_COLUMNS);
  const known = new Set(all);
  return wanted.filter((name) => known.has(name));
}
