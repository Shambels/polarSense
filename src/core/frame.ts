import type { Node } from 'web-tree-sitter';
import type { SourceRef } from './types.js';
import { callArguments, dottedName, methodName, stringValue } from './ast.js';
import type { BindingTable, Definition } from './bindings.js';

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
  /** Row-changing but schema-preserving: filter, sort, head, unique, … */
  | { op: 'identity' }
  /** Reshapes the frame in a way we do not model — pivot, unpivot, transpose. */
  | { op: 'opaque'; method: string };

/** Methods that change which rows come back but never which columns. */
const IDENTITY_METHODS = new Set([
  'filter', 'sort', 'head', 'tail', 'limit', 'slice', 'unique', 'drop_nulls', 'drop_nans',
  'reverse', 'sample', 'shift', 'top_k', 'bottom_k', 'lazy', 'collect', 'clone', 'cache',
  'fill_null', 'fill_nan', 'interpolate', 'set_sorted', 'rechunk', 'clear', 'first', 'last',
  'sort_by', 'gather', 'take', 'extend', 'vstack', 'remove'
]);

/** Methods that reshape the frame in ways this model does not attempt. */
const OPAQUE_METHODS = new Set([
  'pivot', 'unpivot', 'melt', 'transpose', 'explode', 'unnest', 'unstack',
  'group_by_dynamic', 'rolling', 'upsample', 'join_asof', 'partition_by', 'to_dummies'
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
      );

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

    default: {
      // `loaders.sales` — a frame another module exports. Resolved as an
      // expression rather than a source, so its transforms come across too.
      if (node.type === 'attribute') {
        const attr = node.childForFieldName('attribute')?.text;
        const module = table.moduleFor(dottedName(node.childForFieldName('object')));
        const found = attr && module
          ? fromDefinition(
              module.resolveName(attr, Number.MAX_SAFE_INTEGER, [], false), depth
            )
          : null;
        if (found) return found;
      }
      // `df.lazy` used without calling, subscripts, etc: follow the receiver.
      const source = table.resolve(node);
      return source ? { kind: 'source', source } : null;
    }
  }
}

function callFrame(call: Node, ctx: FrameContext, depth: number): FrameExpr | null {
  const { table } = ctx;
  const fn = call.childForFieldName('function');
  const short = methodName(call);

  // A reader call is where every chain ends.
  const asSource = table.resolve(call);
  if (short && asSource && isReader(short)) return { kind: 'source', source: asSource };

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

  if (fn?.type !== 'attribute' || !short) return null;
  const receiver = fn.childForFieldName('object');
  if (!receiver) return null;

  const input = resolveFrame(receiver, ctx, depth + 1);
  if (!input) return null;

  if (short === 'join') return joinFrame(call, input, ctx, depth);

  const op = classify(short, call);
  return op ? { kind: 'transform', op, input } : input;
}

function isReader(short: string): boolean {
  return /^(read|scan)_/.test(short);
}

function joinFrame(call: Node, left: FrameExpr, ctx: FrameContext, depth: number): FrameExpr | null {
  const { positional, keywords } = callArguments(call);
  const otherNode = positional[0] ?? keywords.get('other');
  const right = otherNode ? resolveFrame(otherNode, ctx, depth + 1) : null;
  if (!right) return null;

  const how = literalString(keywords.get('how')) ?? 'inner';
  const suffix = literalString(keywords.get('suffix')) ?? '_right';

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
      return { op: 'drop', exprs: positional };
    case 'group_by':
      return {
        op: 'group_by',
        exprs: positional.concat(listOf(keywords.get('by'))),
        named: [...keywords.entries()].filter(([k]) => k !== 'by' && k !== 'maintain_order')
      };
    case 'agg':
      return { op: 'agg', exprs: positional, named: [...keywords.entries()] };
    case 'rename': {
      const arg = positional[0] ?? keywords.get('mapping');
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
