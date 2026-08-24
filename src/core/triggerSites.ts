/**
 * The declarative table that decides whether a given argument position wants a
 * column name. One row per polars API. Adding a method is one line here plus one
 * line in the test corpus.
 */

export interface ArgSpec {
  /** 'all' = every positional argument, or a list of accepted indices. */
  positional?: 'all' | number[];
  /** Keyword arguments whose value is a column name (or list of them). */
  kwargs?: string[];
  /** Dict literal keys are column names (rename, cast). */
  dictKeys?: boolean;
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
  drop: { positional: 'all' },
  explode: { positional: 'all' },
  filter: { positional: 'all' },
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
  rename: { dictKeys: true },
  cast: { dictKeys: true },
  pivot: { positional: [0], kwargs: ['on', 'index', 'values'] },
  unpivot: { positional: 'all', kwargs: ['on', 'index'] },
  melt: { kwargs: ['on', 'index', 'value_vars', 'id_vars'] },
  over: { positional: 'all', kwargs: ['partition_by'] },
  sort_by: { positional: 'all', kwargs: ['by'] },
  set_sorted: { positional: 'all' },
  agg: { positional: 'all' }
};

/** Keywords that take a *different* frame's columns than the receiver. */
export const RIGHT_FRAME_KWARGS = new Set(['right_on', 'by_right']);

export type ArgPosition =
  | { kind: 'positional'; index: number }
  | { kind: 'keyword'; name: string }
  | { kind: 'dictKey' };

export function specAccepts(spec: ArgSpec, pos: ArgPosition): boolean {
  switch (pos.kind) {
    case 'positional':
      if (spec.positional === 'all') return true;
      return Array.isArray(spec.positional) && spec.positional.includes(pos.index);
    case 'keyword':
      return !!spec.kwargs?.includes(pos.name);
    case 'dictKey':
      return !!spec.dictKeys;
  }
}
