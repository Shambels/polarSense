import type { Node } from 'web-tree-sitter';
import type { SourceRef } from './types.js';
import { callArguments, dottedName, methodName, stringValue } from './ast.js';
import type { BindingTable, Definition } from './bindings.js';
import { SQL_FUNCS, sqlSource } from './sql.js';

/**
 * A frame as an *expression*, not a file: the source it started from plus every
 * transform applied on the way to the cursor. `df.select("a","b").rename({...})`
 * is three nodes, and evaluating them against the source's columns gives the
 * columns that actually exist at that point.
 *
 * This is the difference between offering every column in the parquet file and
 * offering the two that survived the select.
 */
export type FrameExpr =
  | { kind: 'source'; source: SourceRef }
  | { kind: 'transform'; op: Transform; input: FrameExpr }
  | { kind: 'join'; left: FrameExpr; right: FrameExpr; on: JoinKeys; how: string; suffix: string };

export interface JoinKeys {
  /** Names dropped from the right frame, when the join uses shared keys. */
  shared: string[];
  /** True when we could not work the keys out and must not guess. */
  unknown: boolean;
}

export type Transform =
  | { op: 'select'; exprs: Node[]; named: [string, Node][] }
  | { op: 'with_columns'; exprs: Node[]; named: [string, Node][] }
  | { op: 'drop'; exprs: Node[] }
  | { op: 'rename'; pairs: [string, string][]; unknown: boolean }
  | { op: 'group_by'; exprs: Node[]; named: [string, Node][] }
  | { op: 'agg'; exprs: Node[]; named: [string, Node][] }
  | { op: 'with_row_index'; name: string }
  /** `transpose(column_names=[…])` — the call states the whole output schema. */
  | { op: 'transpose'; names: string[] }
  /** `unnest("a")` — each named struct column is replaced by its own fields. */
  | { op: 'unnest'; names: string[] }
  /** `unpivot`/`melt` — the index columns survive; the rest fold into two. */
  | { op: 'unpivot'; index: string[]; variableName: string; valueName: string }
  /** Row-changing but schema-preserving: filter, sort, head, unique, … */
  | { op: 'identity' }
  /** Reshapes the frame in a way we do not model — pivot, to_dummies, … */
  | { op: 'opaque'; method: string };

/**
 * Methods that change which rows come back but never which columns — including
 * the conversions between libraries, which is what lets a duckdb relation become
 * a pandas frame without the analysis losing track of it.
 */
const IDENTITY_METHODS = new Set([
  'filter', 'sort', 'head', 'tail', 'limit', 'slice', 'unique', 'drop_nulls', 'drop_nans',
  'reverse', 'sample', 'shift', 'top_k', 'bottom_k', 'lazy', 'collect', 'clone', 'cache',
  'fill_null', 'fill_nan', 'interpolate', 'set_sorted', 'rechunk', 'clear', 'first', 'last',
  'sort_by', 'gather', 'take', 'extend', 'vstack', 'remove',
  // `explode` turns each list element into its own row; the column keeps its name.
  'explode',
  // Whole-frame reducers: one row comes back, but every column keeps its name.
  'null_count', 'sum', 'mean', 'median', 'min', 'max', 'std', 'var', 'product', 'quantile',
  // pandas
  'sort_values', 'sort_index', 'dropna', 'drop_duplicates', 'query', 'nlargest',
  'nsmallest', 'astype', 'fillna', 'ffill', 'bfill', 'copy', 'where', 'mask', 'round',
  'abs', 'reindex',
  // duckdb, and the conversions out of it
  'order', 'distinct', 'to_df', 'df', 'fetchdf', 'to_pandas', 'to_arrow', 'to_polars',
  'from_pandas', 'from_arrow'
]);

/** Methods that reshape the frame in ways this model does not attempt. */
const OPAQUE_METHODS = new Set([
  'pivot', 'unstack',
  'group_by_dynamic', 'rolling', 'upsample', 'join_asof', 'partition_by', 'to_dummies',
  // pandas moves columns in and out of the index; duckdb's project and aggregate
  // take SQL this does not parse.
  'set_index', 'reset_index', 'stack', 'pivot_table', 'crosstab', 'project', 'aggregate'
]);

export interface FrameContext {
  table: BindingTable;
}

/**
 * Build the frame expression for a receiver node. Returns null when the chain
 * does not bottom out in a source we recognise.
 */
export function resolveFrame(node: Node, ctx: FrameContext, depth = 0): FrameExpr | null {
  if (depth > 32) return null;
  const { table } = ctx;

  switch (node.type) {
    case 'parenthesized_expression':
      return node.namedChildren[0] ? resolveFrame(node.namedChildren[0]!, ctx, depth + 1) : null;

    case 'identifier':
      return fromDefinition(
        table.resolveName(node.text, node.startIndex, enclosingScopeIds(node), false),
        depth
      ) ?? fallbackFrame(node, ctx, depth);

    case 'await':
      return node.namedChildren[0] ? resolveFrame(node.namedChildren[0]!, ctx, depth + 1) : null;

    case 'conditional_expression': {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const found = resolveFrame(child, ctx, depth + 1);
        if (found) return found;
      }
      return null;
    }

    case 'call':
      return callFrame(node, ctx, depth);

    case 'subscript': {
      const value = node.childForFieldName('value');
      const input = value ? resolveFrame(value, ctx, depth + 1) : null;
      if (!input) return fallbackFrame(node, ctx, depth);
      // `df[["a", "b"]]` is how pandas selects. `df["a"]` is a single column
      // rather than a frame, so it stays the frame it came from.
      const index = node.childForFieldName('subscript');
      if (index && (index.type === 'list' || index.type === 'tuple')) {
        const exprs = index.namedChildren.filter((c): c is Node => !!c);
        return { kind: 'transform', op: { op: 'select', exprs, named: [] }, input };
      }
      return input;
    }

    default:
      return fallbackFrame(node, ctx, depth);
  }
}

/** Anything the walk above does not claim: an exported name, or a bare source. */
function fallbackFrame(node: Node, ctx: FrameContext, depth: number): FrameExpr | null {
  const { table } = ctx;
  // `loaders.sales` — a frame another module exports. Resolved as an expression
  // rather than a source, so its transforms come across too.
  if (node.type === 'attribute') {
    const attr = node.childForFieldName('attribute')?.text;
    const module = table.moduleFor(dottedName(node.childForFieldName('object')));
    const found = attr && module
      ? fromDefinition(module.resolveName(attr, Number.MAX_SAFE_INTEGER, [], false), depth)
      : null;
    if (found) return found;
  }
  // `df.lazy` used without calling, subscripts, etc: follow the receiver.
  const source = table.resolve(node);
  return source ? { kind: 'source', source } : null;
}

function callFrame(call: Node, ctx: FrameContext, depth: number): FrameExpr | null {
  const { table } = ctx;
  const fn = call.childForFieldName('function');
  const short = methodName(call);

  // A reader call is where every chain ends.
  const asSource = table.resolve(call);
  if (short && asSource && isReader(short)) return { kind: 'source', source: asSource };

  // So is a SQL statement naming a file — but only when it really does, or
  // `df.sql("SELECT * FROM self")` would throw away everything done to `df`.
  if (short && asSource && SQL_FUNCS.has(short) && sqlSource(call)) {
    return { kind: 'source', source: asSource };
  }

  if (short === 'concat') {
    const { positional } = callArguments(call);
    const first = positional[0];
    if (first && (first.type === 'list' || first.type === 'tuple')) {
      for (const item of first.namedChildren) {
        if (!item) continue;
        const found = resolveFrame(item, ctx, depth + 1);
        if (found) return found;
      }
    } else if (first) {
      return resolveFrame(first, ctx, depth + 1);
    }
    return null;
  }

  // `load_sales()` — a function whose `return` is the frame. Resolved against
  // its own module, which is what makes an imported loader work at all.
  const returned = fromDefinition(table.callDefinition(call), depth);
  if (returned) return returned;

  if (fn?.type !== 'attribute' || !short) {
    // A call this cannot see into — but a pragma may have named its source, and
    // for a bare `get_frame()` that is the only way a path could be here at all.
    return asSource?.path ? { kind: 'source', source: asSource } : null;
  }
  const receiver = fn.childForFieldName('object');
  if (!receiver) return null;

  const input = resolveFrame(receiver, ctx, depth + 1);
  if (!input) return null;

  if (short === 'join' || short === 'merge') {
    return joinFrame(call, input, ctx, depth, short === 'merge');
  }

  const op = classify(short, call);
  return op ? { kind: 'transform', op, input } : input;
}

function isReader(short: string): boolean {
  return /^(read|scan)_/.test(short);
}

function joinFrame(
  call: Node, left: FrameExpr, ctx: FrameContext, depth: number, pandas = false
): FrameExpr | null {
  const { positional, keywords } = callArguments(call);
  const otherNode = positional[0] ?? keywords.get('other') ?? keywords.get('right');
  const right = otherNode ? resolveFrame(otherNode, ctx, depth + 1) : null;
  if (!right) return null;

  const how = literalString(keywords.get('how')) ?? 'inner';
  // pandas spells it `suffixes=("_x", "_y")`, and only the second half applies
  // to the frame being merged in.
  const suffix = literalString(keywords.get('suffix'))
    ?? rightSuffix(keywords.get('suffixes'))
    ?? (pandas ? '_y' : '_right');

  // polars drops the right frame's key columns only when `on=` is used; with
  // left_on/right_on both sides keep their own names.
  const onArg = keywords.get('on') ?? positional[1];
  let shared: string[] = [];
  let unknown = false;
  if (onArg) {
    const names = stringList(onArg);
    if (names) shared = names;
    else unknown = true;
  }
  return { kind: 'join', left, right, on: { shared, unknown }, how, suffix };
}

function classify(method: string, call: Node): Transform | null {
  const { positional, keywords } = callArguments(call);

  switch (method) {
    case 'select':
      return { op: 'select', exprs: positional, named: [...keywords.entries()] };
    case 'with_columns':
      return { op: 'with_columns', exprs: positional, named: [...keywords.entries()] };
    case 'drop':
      return { op: 'drop', exprs: positional.concat(listOf(keywords.get('columns'))) };
    // pandas builds columns by keyword: `df.assign(total=…)`.
    case 'assign':
      return { op: 'with_columns', exprs: [], named: [...keywords.entries()] };
    case 'groupby':
    case 'group_by':
      return {
        op: 'group_by',
        exprs: positional.concat(listOf(keywords.get('by'))),
        named: [...keywords.entries()].filter(([k]) => k !== 'by' && k !== 'maintain_order')
      };
    case 'agg':
      return { op: 'agg', exprs: positional, named: [...keywords.entries()] };
    case 'rename': {
      const arg = positional[0] ?? keywords.get('mapping') ?? keywords.get('columns');
      if (!arg || arg.type !== 'dictionary') return { op: 'rename', pairs: [], unknown: true };
      const pairs: [string, string][] = [];
      let unknown = false;
      for (const pair of arg.namedChildren) {
        if (!pair || pair.type !== 'pair') continue;
        const from = pair.childForFieldName('key');
        const to = pair.childForFieldName('value');
        const a = from ? stringValue(from) : null;
        const b = to ? stringValue(to) : null;
        if (a === null || b === null) { unknown = true; continue; }
        pairs.push([a, b]);
      }
      return { op: 'rename', pairs, unknown };
    }
    case 'transpose': {
      const names = transposedNames(keywords);
      return names ? { op: 'transpose', names } : { op: 'opaque', method };
    }
    case 'unnest': {
      const args = positional.length ? positional : listOf(keywords.get('columns'));
      const names: string[] = [];
      for (const arg of args) {
        const list = stringList(arg);
        if (!list) return { op: 'opaque', method };
        names.push(...list);
      }
      // `separator=` prefixes every field with the struct it came from; not modelled.
      if (!names.length || keywords.has('separator')) return { op: 'opaque', method };
      return { op: 'unnest', names };
    }
    case 'unpivot':
    case 'melt': {
      // Read by keyword only: polars puts `on` in the first position and pandas'
      // `melt` puts `id_vars` there, and reading one as the other would not fail
      // — it would quietly produce a column list belonging to the other library.
      if (positional.length) return { op: 'opaque', method };
      const indexArg = keywords.get('index') ?? keywords.get('id_vars');
      const index = indexArg ? stringList(indexArg) : [];
      const variableName = keywordString(keywords, ['variable_name', 'var_name'], 'variable');
      const valueName = keywordString(keywords, ['value_name'], 'value');
      if (!index || variableName === null || valueName === null) {
        return { op: 'opaque', method };
      }
      return { op: 'unpivot', index, variableName, valueName };
    }
    case 'with_row_index':
    case 'with_row_count': {
      const arg = positional[0] ?? keywords.get('name');
      const name = arg ? stringValue(arg) : null;
      return { op: 'with_row_index', name: name ?? 'index' };
    }
    default:
      if (IDENTITY_METHODS.has(method)) return { op: 'identity' };
      if (OPAQUE_METHODS.has(method)) return { op: 'opaque', method };
      // An unknown method is most likely a user helper returning the same frame.
      return { op: 'opaque', method };
  }
}

/**
 * The output columns of `df.transpose(…)`. Only the call that passes
 * `column_names` can be modelled: without it polars names the columns
 * `column_0…`, and how many there are is the input's *row* count — a number no
 * amount of reading the code will produce.
 */
function transposedNames(keywords: Map<string, Node>): string[] | null {
  const given = keywords.get('column_names');
  const names = given ? stringList(given) : null;
  if (!names) return null;
  const include = keywords.get('include_header');
  if (!include || include.text === 'False') return names; // the default is False
  // A variable here means we cannot say whether the header column is there.
  if (include.text !== 'True') return null;
  const header = keywords.has('header_name')
    ? literalString(keywords.get('header_name'))
    : 'column';
  return header === null ? null : [header, ...names];
}

/** A keyword's literal string under any of its spellings, or `fallback` when absent. */
function keywordString(
  keywords: Map<string, Node>, names: string[], fallback: string
): string | null {
  for (const name of names) {
    const node = keywords.get(name);
    if (node) return stringValue(node);
  }
  return fallback;
}

/** The right-hand half of pandas' `suffixes=("_x", "_y")`. */
function rightSuffix(node: Node | undefined): string | null {
  if (!node || (node.type !== 'tuple' && node.type !== 'list')) return null;
  const second = node.namedChildren[1];
  return second ? stringValue(second) : null;
}

function listOf(node: Node | undefined): Node[] {
  if (!node) return [];
  if (node.type === 'list' || node.type === 'tuple') {
    return node.namedChildren.filter((c): c is Node => !!c);
  }
  return [node];
}

function literalString(node: Node | undefined): string | null {
  return node ? stringValue(node) : null;
}

function stringList(node: Node): string[] | null {
  if (node.type === 'string' || node.type === 'concatenated_string') {
    const value = stringValue(node);
    return value === null ? null : [value];
  }
  if (node.type === 'list' || node.type === 'tuple') {
    const out: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) return null;
      const value = stringValue(child);
      if (value === null) return null;
      out.push(value);
    }
    return out;
  }
  return null;
}

/**
 * The first of a definition's candidates that resolves to a frame — evaluated in
 * the module the definition came from, not the one that imported it.
 */
function fromDefinition(def: Definition | null, depth: number): FrameExpr | null {
  if (!def) return null;
  for (const expr of def.exprs) {
    const found = resolveFrame(expr, { table: def.table }, depth + 1);
    if (found) return found;
  }
  return null;
}

function enclosingScopeIds(node: Node): number[] {
  const out: number[] = [];
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_definition') out.push(cur.id);
    cur = cur.parent;
  }
  return out;
}

/** Every source the expression reads from, in order. */
export function framesSources(expr: FrameExpr): SourceRef[] {
  switch (expr.kind) {
    case 'source': return [expr.source];
    case 'transform': return framesSources(expr.input);
    case 'join': return [...framesSources(expr.left), ...framesSources(expr.right)];
  }
}
