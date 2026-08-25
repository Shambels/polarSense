/**
 * The declarative table that decides whether a given argument position wants a
 * column name. One row per API. Adding a method is one line here plus one line
 * in the test corpus.
 *
 * Rows are keyed by method name alone, deliberately: the receiver still has to
 * resolve to a file we can read, so a pandas or duckdb row costs nothing when
 * the name never appears. That is why supporting three libraries is mostly this
 * table getting longer rather than the resolver learning about dialects.
 */

export interface ArgSpec {
  /** 'all' = every positional argument, or a list of accepted indices. */
  positional?: 'all' | number[];
  /** Keyword arguments whose value is a column name (or list of them). */
  kwargs?: string[];
  /** Keys of a dict passed positionally are column names (rename, cast). */
  dictKeys?: boolean;
  /** Keywords whose dict *keys* are column names — `rename(columns={…})`. */
  dictKwargs?: string[];
}

/**
 * Expression constructors: `pl.col("…")`. These have no receiver of their own —
 * the frame is found by walking outward to the enclosing frame method.
 */
export const EXPR_FUNCS: Record<string, ArgSpec> = {
  col: { positional: 'all' },
  exclude: { positional: 'all' },
  first: { positional: 'all' },
  last: { positional: 'all' },
  sum: { positional: 'all' },
  mean: { positional: 'all' },
  median: { positional: 'all' },
  min: { positional: 'all' },
  max: { positional: 'all' },
  std: { positional: [0] },
  var: { positional: [0] },
  count: { positional: 'all' },
  n_unique: { positional: 'all' },
  struct: { positional: 'all' },
  concat_str: { positional: 'all' },
  concat_list: { positional: 'all' },
  coalesce: { positional: 'all' }
};

/**
 * Frame and expression methods. The receiver is the object the method was
 * called on; `.over`/`.sort_by` are expression-level but resolve the same way.
 */
export const FRAME_METHODS: Record<string, ArgSpec> = {
  select: { positional: 'all' },
  with_columns: { positional: 'all' },
  drop: { positional: 'all', kwargs: ['columns'] },
  explode: { positional: 'all', kwargs: ['column'] },
  filter: { positional: 'all', kwargs: ['items'] },
  unique: { positional: 'all', kwargs: ['subset'] },
  drop_nulls: { positional: 'all', kwargs: ['subset'] },
  fill_null: { kwargs: ['subset'] },
  sort: { positional: 'all', kwargs: ['by'] },
  top_k: { kwargs: ['by'] },
  bottom_k: { kwargs: ['by'] },
  group_by: { positional: 'all', kwargs: ['by'] },
  partition_by: { positional: 'all', kwargs: ['by'] },
  group_by_dynamic: { positional: [0], kwargs: ['index_column', 'by', 'group_by'] },
  rolling: { positional: [0], kwargs: ['index_column', 'by', 'group_by'] },
  upsample: { positional: [0], kwargs: ['time_column', 'by', 'group_by'] },
  join: { kwargs: ['on', 'left_on', 'right_on'] },
  join_asof: { kwargs: ['on', 'left_on', 'right_on', 'by', 'by_left', 'by_right'] },
  rename: { dictKeys: true, dictKwargs: ['mapping', 'columns'] },
  cast: { dictKeys: true },
  pivot: { positional: [0], kwargs: ['on', 'index', 'values', 'columns'] },
  unpivot: { positional: 'all', kwargs: ['on', 'index'] },
  melt: { kwargs: ['on', 'index', 'value_vars', 'id_vars'] },
  over: { positional: 'all', kwargs: ['partition_by'] },
  sort_by: { positional: 'all', kwargs: ['by'] },
  set_sorted: { positional: 'all' },
  get_column: { positional: [0] },
  get_column_index: { positional: [0] },
  drop_in_place: { positional: [0] },
  agg: { positional: 'all', dictKeys: true },

  // --- pandas ---
  groupby: { positional: 'all', kwargs: ['by'] },
  sort_values: { positional: 'all', kwargs: ['by'] },
  drop_duplicates: { kwargs: ['subset'] },
  duplicated: { kwargs: ['subset'] },
  dropna: { kwargs: ['subset'] },
  set_index: { positional: 'all', kwargs: ['keys'] },
  merge: { kwargs: ['on', 'left_on', 'right_on'] },
  astype: { dictKeys: true },
  value_counts: { positional: 'all', kwargs: ['subset'] },
  pivot_table: { kwargs: ['index', 'columns', 'values'] },
  nlargest: { positional: [1], kwargs: ['columns'] },
  nsmallest: { positional: [1], kwargs: ['columns'] },
  query: { positional: [0] },

  // --- duckdb's relational API ---
  project: { positional: [0], kwargs: ['project_expr'] },
  order: { positional: [0], kwargs: ['order_expr'] },
  aggregate: { positional: 'all', kwargs: ['aggr_expr', 'group_expr'] }
};

/**
 * Methods whose string argument is an *expression* — `df.query("revenue > 100")`,
 * `rel.project("region, revenue")` — rather than one whole column name.
 * Completing full names there is still the useful thing to do; checking the
 * string against the schema afterwards is not, so these sites are marked.
 */
export const FRAGMENT_METHODS = new Set(['query', 'project', 'order', 'aggregate']);

/** Keywords that take a *different* frame's columns than the receiver. */
export const RIGHT_FRAME_KWARGS = new Set(['right_on', 'by_right']);

export type ArgPosition =
  | { kind: 'positional'; index: number }
  | { kind: 'keyword'; name: string }
  /** `keyword` is the argument the dict was passed as, or null when positional. */
  | { kind: 'dictKey'; keyword: string | null };

export function specAccepts(spec: ArgSpec, pos: ArgPosition): boolean {
  switch (pos.kind) {
    case 'positional':
      if (spec.positional === 'all') return true;
      return Array.isArray(spec.positional) && spec.positional.includes(pos.index);
    case 'keyword':
      return !!spec.kwargs?.includes(pos.name);
    case 'dictKey':
      if (pos.keyword === null) return !!spec.dictKeys;
      return !!spec.dictKwargs?.includes(pos.keyword);
  }
}
