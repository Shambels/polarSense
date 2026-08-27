import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { SourceRef } from '../core/types.js';
import type { Storage } from '../storage/index.js';
import { COMPRESSORS } from './compressors.js';
import { parquetDtype, type ParquetNode } from './dtypes.js';
import { csvTable, readCsvPrefix } from './csv.js';

/**
 * One or two columns, unformatted, for something that has to do arithmetic on
 * them — which today is the chart aggregator and nothing else.
 *
 * It is deliberately not `readRows`. A page is a hundred rows of forty columns
 * formatted for a grid; this is a whole column as the file holds it, because a
 * bin count cannot be computed from a hundred truncated strings. The two reads
 * are opposite corners of the same file and neither is honest doing the other's
 * job.
 *
 * What keeps it bounded is `maxRows`, and what keeps it truthful is saying so:
 * a read that stopped short is a sample, and every number computed from it has
 * to carry that word.
 */
export interface Series {
  name: string;
  dtype: string;
  /** Values as the reader handed them over: numbers, Dates, strings, nulls. */
  values: unknown[];
}

export interface SeriesRead {
  series: Series[];
  rowsRead: number;
  /** Rows in the file, when the format records it. */
  rowCount?: number;
  /** Every row was read, so an aggregate of this is the file's own, not a sample. */
  complete: boolean;
  /** Set when the values came out of a bounded prefix — as `readCsvRows` does. */
  prefixBytes?: number;
}

export interface SeriesRequest {
  columns: string[];
  /** Rows to read at most. The cap is the whole cost model of this reader. */
  maxRows: number;
}

/**
 * Parquet is the good case, again and for the same reason: two columns of a
 * two-hundred-column file are two column chunks, so a scatter of `revenue`
 * against `units` never touches the other hundred and ninety-eight.
 */
export async function readParquetSeries(
  storage: Storage,
  uri: string,
  request: SeriesRequest
): Promise<SeriesRead> {
  const buffer = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(buffer);
  const rowCount = Number(metadata.num_rows ?? 0);
  const schema = parquetSchema(metadata) as unknown as ParquetNode;
  const dtypes = new Map(
    schema.children.map((child) => [child.element.name, parquetDtype(child)])
  );

  const wanted = request.columns.filter((name) => dtypes.has(name));
  const series: Series[] = wanted.map((name) => ({
    name, dtype: dtypes.get(name) ?? '', values: []
  }));
  const rowEnd = Math.min(rowCount, Math.max(0, request.maxRows));
  if (!wanted.length || rowEnd <= 0) {
    return { series, rowsRead: 0, rowCount, complete: rowEnd >= rowCount };
  }

  // Objects rather than row arrays: hyparquet orders the cells of a row by the
  // file's schema, not by the order they were asked for, and a chart that swaps
  // its axes when a column is renamed is worse than no chart.
  const objects = await parquetReadObjects({
    file: buffer,
    metadata,
    columns: wanted,
    compressors: COMPRESSORS,
    rowStart: 0,
    rowEnd
  });
  for (const object of objects) {
    for (const column of series) column.values.push(object[column.name] ?? null);
  }

  return { series, rowsRead: objects.length, rowCount, complete: rowEnd >= rowCount };
}

/**
 * CSV, out of the same bounded prefix everything else here reads, and with the
 * same admission attached: this is the top of the file, not the file. Every
 * value is a string — what parses as a number is the aggregator's decision,
 * because a CSV with dtype inference off has nothing else to go on.
 */
export async function readCsvSeries(
  uri: string,
  kwargs: SourceRef['kwargs'],
  options: { sniffBytes: number },
  request: SeriesRequest
): Promise<SeriesRead> {
  const { text, truncated } = await readCsvPrefix(uri, options.sniffBytes);
  const table = csvTable(text, kwargs, { start: 0, limit: Math.max(0, request.maxRows) });

  const records = [...table.records];
  // The prefix stopped mid-line, so its last record is half a row: a value cut
  // in two is a wrong number rather than a missing one.
  if (truncated && !table.more && records.length) records.pop();

  const wanted = request.columns.filter((name) => table.names.includes(name));
  const series = wanted.map((name) => {
    const index = table.names.indexOf(name);
    return { name, dtype: '', values: records.map((record) => record[index] ?? null) };
  });

  return {
    series,
    rowsRead: records.length,
    rowCount: undefined,
    complete: !truncated && !table.more,
    prefixBytes: truncated ? options.sniffBytes : undefined
  };
}
