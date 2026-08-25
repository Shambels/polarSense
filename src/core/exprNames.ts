import type { Node } from 'web-tree-sitter';
import { callArguments, dottedName, methodName, stringValue } from './ast.js';
import { isSelectorNamespace, selectorSet } from './selectors.js';
import type { Column } from './types.js';

/**
 * What names does a polars expression produce?
 *
 * `pl.col("a")` makes a column called "a"; `.alias("z")` renames it; `pl.all()`
 * means every column of the input; `cs.numeric()` means whichever of the input's
 * columns are numbers. When none of those fit — a computed name, a regex, a
 * selector method we do not model — the answer is "unknown", and answering that
 * honestly is what stops the schema evaluator from inventing a column list.
 */
export type NameSet =
  | { kind: 'names'; names: string[] }
  /** Every column of the input frame. */
  | { kind: 'all' }
  /** Every column of the input frame except these. */
  | { kind: 'except'; names: string[] }
  /**
   * A selector: whichever of the input's columns the predicate picks. Unlike the
   * cases above this needs the input's columns to mean anything, so it is only
   * ever resolved where they are known — see `expand` in schemaEval.
   */
  | { kind: 'match'; test: (column: Column) => boolean; needsDtype?: boolean }
  /** Not statically knowable — a regex, a computed name, an unmodelled selector. */
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
  /** Local names for the polars.selectors module, e.g. {"cs"}. */
  selectorAliases: Set<string>;
  /** Selectors imported bare: `from polars.selectors import numeric`. */
  bareSelectorFuncs: Set<string>;
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

    case 'binary_operator': {
      const left = node.namedChildren[0];
      if (!left) return UNKNOWN;
      const a = exprNames(left, ctx, depth + 1);
      const right = node.namedChildren[1];
      const b = right ? exprNames(right, ctx, depth + 1) : UNKNOWN;
      // Selectors compose with set algebra: `cs.numeric() - cs.by_name("id")`.
      if (a.kind === 'match' || b.kind === 'match') {
        return combine(node.childForFieldName('operator')?.text ?? '', a, b);
      }
      // Otherwise it is arithmetic, and polars keeps the leftmost name.
      return a;
    }

    case 'comparison_operator':
    case 'boolean_operator': {
      // `pl.col("a") > 3` keeps the leftmost name, as polars does.
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

  // Checked before the polars-module case: `pl.selectors.first()` is a selector,
  // not the `pl.first()` expression constructor of the same short name.
  const isSelector = fn?.type === 'identifier'
    ? ctx.bareSelectorFuncs.has(fn.text)
    : fn?.type === 'attribute' &&
      isSelectorNamespace(dottedName(fn.childForFieldName('object')), ctx);
  if (short && isSelector) return selectorSet(short, call);

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
    if (short === 'keep') return exprNames(receiver, ctx, depth + 1);
    if (short === 'to_lowercase' || short === 'to_uppercase') {
      // Rewriting names we do not have — `pl.all()`, a selector — is guesswork.
      const base = exprNames(receiver, ctx, depth + 1);
      if (base.kind !== 'names') return UNKNOWN;
      const f = short === 'to_lowercase' ? (n: string) => n.toLowerCase() : (n: string) => n.toUpperCase();
      return { kind: 'names', names: base.names.map(f) };
    }
    if (NAME_PRESERVING.has(short)) return exprNames(receiver, ctx, depth + 1);

    // Namespaces pass through: `.str`, `.dt`, `.list`, `.name`, `.struct`.
    const base = exprNames(receiver, ctx, depth + 1);
    // …but a method we do not model on top of a selector can change which
    // columns it picks — `cs.numeric().exclude(…)` — so stop claiming to know.
    if (base.kind === 'match') return UNKNOWN;
    return base;
  }

  return UNKNOWN;
}

/** The union of several name sets, in argument order. */
export function mergeAll(sets: NameSet[]): NameSet {
  // A selector among them makes the whole thing a predicate: order stops
  // mattering, because what comes back is a subset of the input's own columns.
  if (sets.some((s) => s.kind === 'match')) {
    const tests = sets.map(asTest);
    if (tests.some((t) => !t)) return UNKNOWN;
    return {
      kind: 'match',
      test: (column) => tests.some((t) => t!(column)),
      needsDtype: sets.some((s) => s.kind === 'match' && s.needsDtype)
    };
  }

  const names: string[] = [];
  let sawAll = false;
  for (const set of sets) {
    if (set.kind === 'unknown') return UNKNOWN;
    if (set.kind === 'except') return UNKNOWN; // only meaningful on its own
    if (set.kind === 'all') { sawAll = true; continue; }
    if (set.kind === 'names') names.push(...set.names);
  }
  if (sawAll && names.length === 0) return { kind: 'all' };
  if (sawAll) return UNKNOWN; // `pl.all(), pl.col("x")` — order matters, don't guess
  return { kind: 'names', names };
}

/** A name set as a predicate, for the cases where a selector is involved. */
function asTest(set: NameSet): ((column: Column) => boolean) | null {
  switch (set.kind) {
    case 'match': return set.test;
    case 'all': return () => true;
    case 'names': {
      const wanted = new Set(set.names);
      return (column) => wanted.has(column.name);
    }
    case 'except': {
      const gone = new Set(set.names);
      return (column) => !gone.has(column.name);
    }
    case 'unknown': return null;
  }
}

/** Selector set algebra: union, intersection, difference, symmetric difference. */
function combine(operator: string, a: NameSet, b: NameSet): NameSet {
  const left = asTest(a);
  const right = asTest(b);
  if (!left || !right) return UNKNOWN;
  const needsDtype =
    (a.kind === 'match' && !!a.needsDtype) || (b.kind === 'match' && !!b.needsDtype);
  switch (operator) {
    case '|': return { kind: 'match', test: (c) => left(c) || right(c), needsDtype };
    case '&': return { kind: 'match', test: (c) => left(c) && right(c), needsDtype };
    case '-': return { kind: 'match', test: (c) => left(c) && !right(c), needsDtype };
    case '^': return { kind: 'match', test: (c) => left(c) !== right(c), needsDtype };
    default: return UNKNOWN;
  }
}
