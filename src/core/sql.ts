import type { Node } from 'web-tree-sitter';
import { callArguments, stringValue } from './ast.js';
import type { SourceKind, SourceRef } from './types.js';

/**
 * The one place a data file hides inside a string rather than being one:
 * `duckdb.sql("SELECT * FROM 'sales.parquet'")`.
 *
 * This is not a SQL parser and does not want to be. It looks for the two shapes
 * duckdb users actually write — a reader call, or a quoted path with a known
 * extension — and finds nothing otherwise, which is what keeps
 * `con.execute("SELECT * FROM users")` from claiming to be a parquet file.
 */

/** Call names whose first argument is SQL rather than a path. */
export const SQL_FUNCS = new Set(['sql', 'query', 'execute', 'from_query']);

const READER_KINDS: Record<string, SourceKind> = {
  read_parquet: 'parquet',
  parquet_scan: 'parquet',
  read_csv: 'csv',
  read_csv_auto: 'csv',
  delta_scan: 'delta',
  iceberg_scan: 'iceberg'
};

const READER_CALL =
  /\b(read_parquet|parquet_scan|read_csv_auto|read_csv|delta_scan|iceberg_scan)\s*\(\s*(['"])([^'"]+)\2/i;
const QUOTED = /(['"])([^'"]+)\1/g;

const EXTENSIONS: [RegExp, SourceKind][] = [
  [/\.(parquet|pq)$/i, 'parquet'],
  [/\.(csv|tsv|txt)$/i, 'csv'],
  [/\.(arrow|ipc|feather)$/i, 'ipc']
];

export interface SqlPath {
  kind: SourceKind;
  path: string;
  /** Offset of the path within the SQL, so an editor can link to it. */
  index: number;
}

/** The data file a SQL statement reads, when it names one plainly. */
export function dataPathInSql(sql: string): SqlPath | null {
  const reader = READER_CALL.exec(sql);
  if (reader) {
    const kind = READER_KINDS[reader[1].toLowerCase()];
    if (kind) {
      return { kind, path: reader[3], index: reader.index + reader[0].lastIndexOf(reader[3]) };
    }
  }
  for (const match of sql.matchAll(QUOTED)) {
    const value = match[2];
    const kind = EXTENSIONS.find(([pattern]) => pattern.test(value))?.[1];
    if (kind && match.index !== undefined) {
      return { kind, path: value, index: match.index + 1 };
    }
  }
  return null;
}

export interface SqlSource {
  source: SourceRef;
  /** The string argument holding the SQL. */
  sql: Node;
  /** Offset of the path within that string's contents. */
  index: number;
}

/** The source a `duckdb.sql(…)`-shaped call reads, if its SQL names a file. */
export function sqlSource(call: Node): SqlSource | null {
  const { positional, keywords } = callArguments(call);
  const arg = positional[0] ?? keywords.get('query') ?? keywords.get('sql');
  if (!arg) return null;
  const text = stringValue(arg);
  if (text === null) return null;
  const found = dataPathInSql(text);
  if (!found) return null;
  return { source: { kind: found.kind, path: found.path, kwargs: {} }, sql: arg, index: found.index };
}
