import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import type { Storage } from '../storage/index.js';
import { COMPRESSORS } from './compressors.js';

/**
 * The values a column actually holds — the one place this extension reads data
 * rather than metadata, which is why it is off until asked for.
 *
 * What it reads is one column of the first `maxRows` rows: parquet is columnar,
 * so that is one column chunk rather than a scan of the file, and a
 * dictionary-encoded column — the low-cardinality case this is for — decodes its
 * dictionary page once and then a run of indices into it.
 */
export interface ValueSet {
  /** Most common first: the frequent values are the ones worth having on top. */
  values: string[];
  /** True when every row was read, so this is the column's whole domain. */
  complete: boolean;
}

export interface ValueOptions {
  /** How many rows to look at. */
  maxRows: number;
  /** Above this many distinct values, offer nothing at all. */
  maxDistinct: number;
}

/**
 * Values of one column, or null when there is no useful answer: too many
 * distinct values to be a list worth reading, nothing but nulls, or a column
 * whose values are not strings.
 *
 * Null rather than a short list, deliberately. A hundred of four million order
 * ids is not a completion list, it is a lie about how many there are — and the
 * columns worth completing are exactly the ones with few enough values to show.
 */
export async function readParquetValues(
  storage: Storage,
  uri: string,
  column: string,
  options: ValueOptions
): Promise<ValueSet | null> {
  const buffer = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(buffer);
  const rowCount = Number(metadata.num_rows ?? 0);
  if (rowCount === 0) return null;
  const rowEnd = Math.min(rowCount, Math.max(1, options.maxRows));

  const counts = new Map<string, number>();
  let overflowed = false;

  try {
    await parquetRead({
      file: buffer,
      metadata,
      columns: [column],
      compressors: COMPRESSORS,
      rowStart: 0,
      rowEnd,
      onComplete: (rows: unknown[][]) => {
        for (const row of rows) {
          const value = row[0];
          // Nulls and non-strings are skipped rather than rendered: what goes in
          // here is typed inside quotes, so a number would be the wrong literal.
          if (typeof value !== 'string' || value === '') continue;
          const seen = counts.get(value);
          if (seen === undefined && counts.size >= options.maxDistinct) {
            overflowed = true;
            return;
          }
          counts.set(value, (seen ?? 0) + 1);
        }
      }
    });
  } catch {
    // A codec hyparquet cannot decompress, or a column that is not there.
    return null;
  }

  if (overflowed || counts.size === 0) return null;

  const values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
  return { values, complete: rowEnd >= rowCount };
}
