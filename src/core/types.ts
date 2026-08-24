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

export interface Column {
  name: string;
  /** polars display name, e.g. "str", "i64", "datetime[μs, UTC]". Empty when unknown. */
  dtype: string;
}

export interface Schema {
  columns: Column[];
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

export interface Resolution {
  /** The source the cursor's frame reads from, when we found exactly one. */
  source?: SourceRef;
  /** Every source known in the document, used for the fallback offer. */
  allSources: SourceRef[];
  /** The range of the string contents being completed, as byte offsets in the source. */
  contentStart: number;
  contentEnd: number;
  failure?: ResolutionFailure;
}
