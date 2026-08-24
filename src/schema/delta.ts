import type { Column } from '../core/types.js';
import { joinUri, type Storage } from '../storage/index.js';
import { deltaDtype } from './dtypes.js';

const COMMIT = /^\d{20}\.json$/;

/**
 * Walk `_delta_log` newest-first looking for the most recent `metaData` action;
 * its `schemaString` is the table's current schema. Later commits usually carry
 * only `add`/`remove` actions, so the walk normally goes back a few files.
 *
 * Tables whose JSON commits have been truncated by a checkpoint leave only
 * `*.checkpoint.parquet`, which is not handled here — the table simply reports
 * no columns rather than reporting stale ones.
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
  return [];
}

export function parseDeltaSchemaString(schemaString: string): Column[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaString);
  } catch {
    return [];
  }
  const fields = (parsed as Record<string, unknown>)?.['fields'];
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => {
    const f = field as Record<string, unknown>;
    return { name: String(f['name'] ?? ''), dtype: deltaDtype(f['type']) };
  }).filter((c) => c.name !== '');
}
