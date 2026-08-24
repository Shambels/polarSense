/** Shared vocabulary for the analysis + schema layers. Nothing here imports vscode. */

export type SourceKind = 'parquet' | 'csv' | 'ipc' | 'delta' | 'iceberg';

/** Where a frame's columns come from, as read off the call site. */
export interface SourceRef {
  kind: SourceKind;
  /** Path/URI as written, after constant folding. Null when we could not fold it. */
  path: string | null;
  /** Literal keyword arguments at the call site that change how the file is read. */
  kwargs: Record<string, string | number | boolean | string[] | null>;
  /** Variable this was bound to, for logging and the status bar. */
  symbol?: string;
}

/** What the file's own metadata says about a column, when it says anything. */
export interface ColumnStats {
  nullCount?: number;
  /** Already formatted for display — the reader knows the dtype, the hover does not. */
  min?: string;
  max?: string;
}

export interface Column {
  name: string;
  /** polars display name, e.g. "str", "i64", "datetime[μs, UTC]". Empty when unknown. */
  dtype: string;
  stats?: ColumnStats;
}

export interface Schema {
  columns: Column[];
  /** Rows in the file, when the format records it. */
  rowCount?: number;
  /** Human-readable origin, shown in the completion detail. */
  origin: string;
}

/** Why a completion request produced nothing — surfaced in the status bar. */
export type ResolutionFailure =
  | 'not-in-string'
  | 'not-a-column-site'
  | 'no-frame'
  | 'unknown-binding'
  | 'unresolvable-path'
  | 'file-not-found'
  | 'unsupported-scheme'
  | 'read-failed';

/** The cursor is inside the *path* argument of a reader, not a column name. */
export interface PathSite {
  kind: SourceKind;
  /** What has been typed so far, from the start of the string to the cursor. */
  prefix: string;
}

export interface Resolution {
  /** The source the cursor's frame reads from, when we found exactly one. */
  source?: SourceRef;
  /** Set instead of `source` when the cursor is in a reader's path argument. */
  pathSite?: PathSite;
  /** Every source known in the document, used for the fallback offer. */
  allSources: SourceRef[];
  /** The range of the string contents being completed, as byte offsets in the source. */
  contentStart: number;
  contentEnd: number;
  failure?: ResolutionFailure;
}
