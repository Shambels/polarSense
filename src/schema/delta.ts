import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import type { Column } from '../core/types.js';
import { joinUri, type Storage } from '../storage/index.js';
import { deltaDtype } from './dtypes.js';
import { COMPRESSORS } from './compressors.js';

const COMMIT = /^\d{20}\.json$/;

/** `<version>.checkpoint.parquet`, and the multi-part and v2 spellings of it. */
const CHECKPOINT = /^(\d{20})\.checkpoint\b.*\.parquet$/;

/**
 * How far into a checkpoint to look when it records no statistics. Every writer
 * puts `protocol` and `metaData` at the top; decoding a million rows to be sure
 * of that is not worth it.
 */
const SCAN_ROWS = 2048;

/**
 * Walk `_delta_log` newest-first looking for the most recent `metaData` action;
 * its `schemaString` is the table's current schema. Later commits usually carry
 * only `add`/`remove` actions, so the walk normally goes back a few files.
 *
 * When the walk finds nothing the schema has usually not gone anywhere: the
 * early commits holding it have been vacuumed, and what is left is a checkpoint
 * parquet. That is the fallback below, and it runs second on purpose — a JSON
 * commit is always newer than the checkpoint beneath it.
 */
export async function readDeltaSchema(storage: Storage, tableUri: string): Promise<Column[]> {
  const logUri = joinUri(tableUri, '_delta_log');
  const entries = await storage.list(logUri);
  const commits = entries
    .filter((e) => !e.isDir && COMMIT.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const commit of commits) {
    const bytes = await storage.readAll(joinUri(logUri, commit)).catch(() => null);
    if (!bytes) continue;
    const text = new TextDecoder('utf-8').decode(bytes);
    // Read a commit's actions bottom-up: the last metaData in a file wins.
    const lines = text.split('\n').filter((l) => l.trim() !== '').reverse();
    for (const line of lines) {
      let action: unknown;
      try {
        action = JSON.parse(line);
      } catch {
        continue;
      }
      const metaData = (action as Record<string, unknown> | null)?.['metaData'] as
        | Record<string, unknown>
        | undefined;
      const schemaString = metaData?.['schemaString'];
      if (typeof schemaString !== 'string') continue;
      const columns = parseDeltaSchemaString(schemaString);
      if (columns.length) return columns;
    }
  }

  const names = entries.filter((e) => !e.isDir).map((e) => e.name);
  return readCheckpointSchema(storage, logUri, names);
}

/**
 * The checkpoint files of the newest checkpointed version, in read order.
 *
 * Chosen from the directory listing rather than from `_last_checkpoint`: the
 * listing is already in hand, and the pointer file can be missing or stale
 * without the checkpoints themselves being either.
 */
export function checkpointFiles(names: string[]): string[] {
  let newest = '';
  for (const name of names) {
    const version = CHECKPOINT.exec(name)?.[1];
    if (version && version > newest) newest = version;
  }
  if (!newest) return [];
  return names.filter((name) => CHECKPOINT.exec(name)?.[1] === newest).sort();
}

/**
 * The schema out of a checkpoint parquet.
 *
 * A checkpoint's rows are the table's actions, one action kind per column, and
 * every row but one has a null `metaData`. Reading that one column is still
 * reading a log rather than anyone's data — the checkpoint is Delta's own
 * bookkeeping, which happens to be written in parquet.
 */
async function readCheckpointSchema(
  storage: Storage,
  logUri: string,
  names: string[]
): Promise<Column[]> {
  for (const name of checkpointFiles(names)) {
    const columns = await readCheckpointFile(storage, joinUri(logUri, name)).catch(() => []);
    if (columns.length) return columns;
  }
  return [];
}

async function readCheckpointFile(storage: Storage, uri: string): Promise<Column[]> {
  const file = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(file);
  const range = metaDataRows(metadata) ?? {
    start: 0,
    end: Math.min(SCAN_ROWS, Number(metadata.num_rows ?? 0))
  };
  if (range.end <= range.start) return [];

  const rows = await parquetReadObjects({
    file,
    metadata,
    columns: ['metaData'],
    compressors: COMPRESSORS,
    rowStart: range.start,
    rowEnd: range.end
  });

  for (const row of rows) {
    const metaData = row?.['metaData'] as Record<string, unknown> | null | undefined;
    const schemaString = metaData?.['schemaString'];
    if (typeof schemaString !== 'string') continue;
    const columns = parseDeltaSchemaString(schemaString);
    if (columns.length) return columns;
  }
  return [];
}

interface RowRange {
  start: number;
  end: number;
}

/**
 * The rows of the first row group holding a metaData action, read off the
 * footer's own null counts — so a checkpoint of a million files still decodes
 * only the handful of rows that could possibly carry the schema.
 */
function metaDataRows(metadata: { row_groups?: unknown[] }): RowRange | null {
  let start = 0;
  for (const group of metadata.row_groups ?? []) {
    const rows = Number((group as { num_rows?: unknown }).num_rows ?? 0);
    let fewest: number | null = null;

    for (const column of (group as { columns?: unknown[] }).columns ?? []) {
      const meta = (column as { meta_data?: Record<string, unknown> }).meta_data;
      const pathInSchema = meta?.['path_in_schema'];
      if (!Array.isArray(pathInSchema) || pathInSchema[0] !== 'metaData') continue;
      const nulls = (meta?.['statistics'] as Record<string, unknown> | undefined)?.['null_count'];
      if (nulls === undefined || nulls === null) continue;
      // Any leaf of the struct will do: they are all null together on the rows
      // that are not a metaData action.
      const count = Number(nulls);
      if (fewest === null || count < fewest) fewest = count;
    }

    if (fewest !== null && fewest < rows) return { start, end: start + rows };
    start += rows;
  }
  return null;
}

export function parseDeltaSchemaString(schemaString: string): Column[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaString);
  } catch {
    return [];
  }
  return deltaFields((parsed as Record<string, unknown>)?.['fields']);
}

/** A struct's fields, keeping the fields of any struct among them. */
function deltaFields(value: unknown): Column[] {
  if (!Array.isArray(value)) return [];
  return value.map((field) => {
    const f = field as Record<string, unknown>;
    const type = f['type'] as Record<string, unknown> | undefined;
    const nested = type?.['type'] === 'struct' ? deltaFields(type['fields']) : [];
    return {
      name: String(f['name'] ?? ''),
      dtype: deltaDtype(f['type']),
      ...(nested.length ? { fields: nested } : {})
    };
  }).filter((c) => c.name !== '');
}
