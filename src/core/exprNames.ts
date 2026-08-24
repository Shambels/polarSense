import type { Node } from 'web-tree-sitter';
import { callArguments, dottedName, methodName, stringValue } from './ast.js';

/**
 * What names does a polars expression produce?
 *
 * `pl.col("a")` makes a column called "a"; `.alias("z")` renames it; `pl.all()`
 * means every column of the input; `cs.numeric()` means something we cannot work
 * out statically. That last case is the important one — answering "unknown"
 * honestly is what stops the schema evaluator from inventing a column list.
 */
export type NameSet =
  | { kind: 'names'; names: string[] }
  /** Every column of the input frame. */
  | { kind: 'all' }
  /** Every column of the input frame except these. */
  | { kind: 'except'; names: string[] }
  /** Not statically knowable — a selector, a regex, a computed name. */
  | { kind: 'unknown' };

export const UNKNOWN: NameSet = { kind: 'unknown' };

/** Expression methods that rename their output outright. */
const RENAMING = new Set(['alias']);

/** Methods whose output name is the receiver's name — aggregations, casts, maths. */
const NAME_PRESERVING = new Set([
  'sum', 'mean', 'median', 'min', 'max', 'std', 'var', 'count', 'n_unique', 'first',
  'last', 'len', 'cast', 'fill_null', 'fill_nan', 'abs', 'round', 'floor', 'ceil',
  'sort', 'reverse', 'unique', 'drop_nulls', 'drop_nans', 'over', 'filter', 'head',
  'tail', 'shift', 'cum_sum', 'cum_count', 'cum_min', 'cum_max', 'diff', 'pct_change',
  'rank', 'is_null', 'is_not_null', 'is_in', 'is_between', 'not', 'sort_by', 'slice',
  'clip', 'log', 'exp', 'sqrt', 'quantile', 'mode', 'product', 'null_count', 'implode',
  'flatten', 'explode', 'gather', 'take', 'set_sorted', 'forward_fill', 'backward_fill'
]);

/** polars module functions whose first string arguments name their output. */
const NAMED_BY_ARGS = new Set([
  'col', 'sum', 'mean', 'median', 'min', 'max', 'std', 'var', 'count', 'n_unique',
  'first', 'last'
]);

export interface ExprContext {
  /** Local names for the polars module, e.g. {"pl"}. */
  polarsAliases: Set<string>;
  /** Expression constructors imported bare: `from polars import col`. */
  bareExprFuncs: Set<string>;
}

/** Names produced by one expression node. */
export function exprNames(node: Node, ctx: ExprContext, depth = 0): NameSet {
  if (depth > 12) return UNKNOWN;

  switch (node.type) {
    case 'string':
    case 'concatenated_string': {
      const value = stringValue(node);
      if (value === null) return UNKNOWN;
      // A regex selector is a column *pattern*, not a column name.
      if (value.startsWith('^') && value.endsWith('$')) return UNKNOWN;
      if (value === '*') return { kind: 'all' };
      return { kind: 'names', names: [value] };
    }

    case 'parenthesized_expression':
      return node.namedChildren[0]
        ? exprNames(node.namedChildren[0]!, ctx, depth + 1)
        : UNKNOWN;

    case 'list':
    case 'tuple':
    case 'set':
      return mergeAll(node.namedChildren.map((c) => (c ? exprNames(c, ctx, depth + 1) : UNKNOWN)));

    case 'binary_operator':
    case 'comparison_operator':
    case 'boolean_operator': {
      // `pl.col("a") + pl.col("b")` keeps the leftmost name, as polars does.
      const left = node.namedChildren[0];
      return left ? exprNames(left, ctx, depth + 1) : UNKNOWN;
    }

    case 'unary_operator':
    case 'not_operator':
      return node.namedChildren[0]
        ? exprNames(node.namedChildren[0]!, ctx, depth + 1)
        : UNKNOWN;

    case 'attribute':
      // A namespace hop: `pl.col("a").name` / `.str` / `.dt` carries the name along.
      return node.childForFieldName('object')
        ? exprNames(node.childForFieldName('object')!, ctx, depth + 1)
        : UNKNOWN;

    case 'call':
      return callNames(node, ctx, depth);

    default:
      return UNKNOWN;
  }
}

function callNames(call: Node, ctx: ExprContext, depth: number): NameSet {
  const fn = call.childForFieldName('function');
  const short = methodName(call);
  const { positional, keywords } = callArguments(call);

  const isPolarsModule = (() => {
    if (fn?.type !== 'attribute') return false;
    const objRoot = dottedName(fn.childForFieldName('object'))?.split('.')[0];
    return !!objRoot && ctx.polarsAliases.has(objRoot);
  })();
  const isBare = fn?.type === 'identifier' && ctx.bareExprFuncs.has(fn.text);

  if (short && (isPolarsModule || isBare)) {
    if (short === 'all') return { kind: 'all' };
    if (short === 'exclude') {
      const inner = mergeAll(positional.map((a) => exprNames(a, ctx, depth + 1)));
      return inner.kind === 'names' ? { kind: 'except', names: inner.names } : UNKNOWN;
    }
    if (short === 'lit') {
      return { kind: 'names', names: ['literal'] };
    }
    if (short === 'len') return { kind: 'names', names: ['len'] };
    if (short === 'struct' || short === 'concat_str' || short === 'concat_list' ||
        short === 'coalesce' || short === 'when' || short === 'format') {
      // These combine columns; without an alias polars names them after the first.
      const inner = mergeAll(positional.map((a) => exprNames(a, ctx, depth + 1)));
      if (inner.kind !== 'names' || !inner.names.length) return UNKNOWN;
      return { kind: 'names', names: [inner.names[0]] };
    }
    if (NAMED_BY_ARGS.has(short)) {
      if (!positional.length) return UNKNOWN;
      return mergeAll(positional.map((a) => exprNames(a, ctx, depth + 1)));
    }
    return UNKNOWN;
  }

  // Method on an expression: `pl.col("a").alias("z")`, `pl.col("a").sum()`.
  if (fn?.type === 'attribute' && short) {
    if (RENAMING.has(short)) {
      const value = positional[0] ?? keywords.get('name');
      const named = value ? exprNames(value, ctx, depth + 1) : UNKNOWN;
      return named.kind === 'names' ? named : UNKNOWN;
    }
    const receiver = fn.childForFieldName('object');
    if (!receiver) return UNKNOWN;

    if (short === 'suffix' || short === 'prefix') {
      // `.name.suffix("_x")` — the receiver chain is `pl.col(...).name`.
      const affix = positional[0] ? stringValue(positional[0]) : null;
      const base = exprNames(receiver, ctx, depth + 1);
      if (affix === null || base.kind !== 'names') return UNKNOWN;
      return {
        kind: 'names',
        names: base.names.map((n) => (short === 'suffix' ? `${n}${affix}` : `${affix}${n}`))
      };
    }
    if (short === 'keep' || short === 'to_lowercase' || short === 'to_uppercase') {
      const base = exprNames(receiver, ctx, depth + 1);
      if (base.kind !== 'names') return base;
      if (short === 'keep') return base;
      const f = short === 'to_lowercase' ? (n: string) => n.toLowerCase() : (n: string) => n.toUpperCase();
      return { kind: 'names', names: base.names.map(f) };
    }
    if (NAME_PRESERVING.has(short)) return exprNames(receiver, ctx, depth + 1);

    // Namespaces pass through: `.str`, `.dt`, `.list`, `.name`, `.struct`.
    return exprNames(receiver, ctx, depth + 1);
  }

  return UNKNOWN;
}

/** Attribute access like `pl.col("a").name` resolves through to the receiver. */
export function mergeAll(sets: NameSet[]): NameSet {
  const names: string[] = [];
  let sawAll = false;
  for (const set of sets) {
    if (set.kind === 'unknown') return UNKNOWN;
    if (set.kind === 'except') return UNKNOWN; // only meaningful on its own
    if (set.kind === 'all') { sawAll = true; continue; }
    names.push(...set.names);
  }
  if (sawAll && names.length === 0) return { kind: 'all' };
  if (sawAll) return UNKNOWN; // `pl.all(), pl.col("x")` — order matters, don't guess
  return { kind: 'names', names };
}
