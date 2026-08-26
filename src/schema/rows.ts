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
}

export interface RowRequest {
  /** Names to read; the file's own order is used for anything not listed. */
  columns?: string[];
  rowStart: number;
  /** How many rows to return. The page is the unit of both reading and drawing. */
  limit: number;
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

  return {
    ...page,
    rows: objects.map((object) =>
      wanted.map((name, i) => formatValue(object[name], dtypes[i], { maxLength: 60 }))
    )
  };
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
  const table = csvTable(text, kwargs, { start: rowStart, limit: Math.max(1, request.limit) });

  const records = [...table.records];
  let more = table.more;
  // The read stopped mid-line, so the last record in a truncated prefix is half
  // a row. A cut-off value shown as data is worse than a row that is not shown.
  if (truncated && !more && records.length) records.pop();

  const wanted = pick(table.names, request.columns);
  const indices = wanted.map((name) => table.names.indexOf(name));

  return {
    columns: wanted,
    dtypes: wanted.map(() => ''),
    allColumns: table.names,
    rowStart,
    rowCount: undefined,
    more,
    prefixBytes: truncated ? options.sniffBytes : undefined,
    rows: records.map((record) => indices.map((i) => record[i] ?? ''))
  };
}

/** The columns asked for that the file actually has, or its first few. */
function pick(all: string[], wanted?: string[]): string[] {
  if (!wanted?.length) return all.slice(0, DEFAULT_COLUMNS);
  const known = new Set(all);
  return wanted.filter((name) => known.has(name));
}
