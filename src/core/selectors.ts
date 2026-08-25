import type { Node } from 'web-tree-sitter';
import { callArguments, stringValue } from './ast.js';
import type { ArgSpec } from './triggerSites.js';
import type { NameSet } from './exprNames.js';
import type { Column } from './types.js';

/**
 * `polars.selectors` — `cs.numeric()`, `cs.by_name("region")`, `cs.starts_with("q_")`.
 *
 * Two jobs, deliberately separate. SELECTOR_FUNCS says which argument positions
 * hold a column name, so completion and the typo check fire inside them.
 * selectorSet says which of a known column list a selector picks, so the schema
 * evaluator can narrow *through* a selector instead of giving up — which is what
 * stops one `cs.numeric()` in a chain from silencing everything after it.
 *
 * Anything not modelled here returns UNKNOWN, which costs a narrowing and a
 * diagnostic but never invents a column list.
 */

/** Selector constructors whose string arguments name columns. */
export const SELECTOR_FUNCS: Record<string, ArgSpec> = {
  by_name: { positional: 'all' },
  exclude: { positional: 'all' },
  starts_with: { positional: 'all' },
  ends_with: { positional: 'all' },
  contains: { positional: 'all' }
};

/**
 * …of those, the ones whose argument is a *fragment* of a name rather than a
 * whole one. Offering full column names there is still the useful thing to do —
 * you pick one and trim it — but warning that "reg" is not a column would be
 * nonsense, so these sites are marked and the diagnostic skips them.
 */
export const PARTIAL_SELECTORS = new Set(['starts_with', 'ends_with', 'contains']);

/** The dtype-group selectors, against the dtype names our readers produce. */
const DTYPE_GROUPS: Record<string, (dtype: string) => boolean> = {
  numeric: (d) => /^[iuf]\d+$/.test(d),
  integer: (d) => /^[iu]\d+$/.test(d),
  signed_integer: (d) => /^i\d+$/.test(d),
  unsigned_integer: (d) => /^u\d+$/.test(d),
  float: (d) => /^f\d+$/.test(d),
  decimal: (d) => d.startsWith('decimal'),
  string: (d) => d === 'str',
  boolean: (d) => d === 'bool',
  binary: (d) => d === 'binary',
  categorical: (d) => d === 'cat',
  date: (d) => d === 'date',
  datetime: (d) => d.startsWith('datetime'),
  time: (d) => d === 'time',
  duration: (d) => d.startsWith('duration'),
  temporal: (d) =>
    d === 'date' || d === 'time' || d.startsWith('datetime') || d.startsWith('duration'),
  list: (d) => d.startsWith('list'),
  struct: (d) => d.startsWith('struct')
};

export interface SelectorContext {
  /** Local names for the polars module, e.g. {"pl"}. */
  polarsAliases: Set<string>;
  /** Local names for the selectors module, e.g. {"cs"}. */
  selectorAliases: Set<string>;
}

/** Is this dotted receiver the selectors module? `cs`, `pl.selectors`, `polars.selectors`. */
export function isSelectorNamespace(name: string | null, ctx: SelectorContext): boolean {
  if (!name) return false;
  if (ctx.selectorAliases.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return name.slice(dot + 1) === 'selectors' && ctx.polarsAliases.has(name.slice(0, dot));
}

const UNKNOWN: NameSet = { kind: 'unknown' };

/** The columns one selector call picks out of its input. */
export function selectorSet(method: string, call: Node): NameSet {
  const { positional } = callArguments(call);

  if (method === 'all') return { kind: 'all' };

  const group = DTYPE_GROUPS[method];
  if (group) {
    // `cs.datetime("ms")` narrows to a time unit we do not track.
    if (positional.length) return UNKNOWN;
    return { kind: 'match', test: (c: Column) => group(c.dtype), needsDtype: true };
  }

  if (!positional.length) return UNKNOWN;
  const names = stringArgs(positional);
  if (!names || !names.length) return UNKNOWN;

  switch (method) {
    case 'by_name':
      // Same as `pl.col(…)`: a name the file does not have is still offered, so
      // that a typo shows up as a typo rather than as a missing suggestion.
      return { kind: 'names', names };
    case 'exclude':
      return { kind: 'except', names };
    case 'starts_with':
      return { kind: 'match', test: (c: Column) => names.some((p) => c.name.startsWith(p)) };
    case 'ends_with':
      return { kind: 'match', test: (c: Column) => names.some((s) => c.name.endsWith(s)) };
    case 'contains':
      return { kind: 'match', test: (c: Column) => names.some((s) => c.name.includes(s)) };
    case 'matches': {
      if (names.length !== 1) return UNKNOWN;
      const pattern = compile(names[0]);
      return pattern ? { kind: 'match', test: (c: Column) => pattern.test(c.name) } : UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

/** Python's regex dialect is close enough for column patterns; anything else is UNKNOWN. */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** String arguments, flattening the list form `cs.by_name(["a", "b"])`. */
function stringArgs(nodes: Node[]): string[] | null {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'list' || node.type === 'tuple' || node.type === 'set') {
      const inner = stringArgs(node.namedChildren.filter((c): c is Node => !!c));
      if (!inner) return null;
      out.push(...inner);
      continue;
    }
    const value = stringValue(node);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}
