import type { Node, Tree } from 'web-tree-sitter';
import type { Resolution, SourceKind, SourceRef } from './types.js';
import { PATH_KWARGS, SOURCE_FUNCS, type BindingTable } from './bindings.js';
import { callArguments, dottedName, lastSegment, nearest } from './ast.js';
import { resolveFrame } from './frame.js';
import {
  EXPR_FUNCS, FRAME_METHODS, RIGHT_FRAME_KWARGS, specAccepts,
  type ArgPosition, type ArgSpec
} from './triggerSites.js';

const CONTAINERS = ['list', 'tuple', 'set', 'dictionary', 'parenthesized_expression'];

/**
 * The §04 walk: from a cursor offset to the schema source whose columns belong there.
 * Pure — no vscode, no I/O — so the whole thing is unit-testable against source strings.
 */
export function resolveAtOffset(
  tree: Tree,
  table: BindingTable,
  offset: number
): Resolution {
  const empty: Resolution = {
    allSources: table.allSources,
    contentStart: offset,
    contentEnd: offset
  };

  const stringNode = enclosingString(tree, offset);
  if (!stringNode) return { ...empty, failure: 'not-in-string' };

  const [contentStart, contentEnd] = stringContentRange(stringNode);
  const base = { ...empty, contentStart, contentEnd };

  const site = findArgumentPosition(stringNode);
  if (!site) return { ...base, failure: 'not-a-column-site' };

  const { call, position } = site;

  // The path argument of a reader is not a column name — but it is a file path,
  // and we already know the workspace roots, so complete that instead.
  const pathKind = pathArgumentKind(call, position);
  if (pathKind) {
    const typed = stringNode.namedChildren.find((c) => c?.type === 'string_content')?.text ?? '';
    const prefix = typed.slice(0, Math.max(0, offset - contentStart));
    return { ...base, pathSite: { kind: pathKind, prefix } };
  }

  const spec = classifyCall(call, table);
  if (!spec || !specAccepts(spec.spec, position)) {
    return { ...base, failure: 'not-a-column-site' };
  }

  // Which frame do these columns belong to?
  let frameExpr: Node | null = null;
  if (spec.kind === 'frame-method') {
    const wantsOtherFrame =
      position.kind === 'keyword' && RIGHT_FRAME_KWARGS.has(position.name);
    if (wantsOtherFrame) {
      // right_on= completes from the frame being joined *in*, not the receiver.
      frameExpr = callArguments(call).positional[0] ?? null;
    } else {
      frameExpr = call.childForFieldName('function')?.childForFieldName('object') ?? null;
    }
  } else {
    // pl.col("…") has no receiver: walk outward to the nearest frame method.
    const owner = enclosingFrameMethod(call, table);
    frameExpr = owner?.childForFieldName('function')?.childForFieldName('object') ?? null;
  }

  if (!frameExpr) return { ...base, failure: 'no-frame' };

  // `.over(…)` and `.sort_by(…)` hang off an *expression* — `pl.col("x").sum()` —
  // not off a frame, so the receiver leads back to the polars module. When that
  // happens, keep walking outward to the frame method that owns the expression.
  if (rootsInPolars(frameExpr, table)) {
    const owner = enclosingFrameMethod(call, table);
    const outer = owner?.childForFieldName('function')?.childForFieldName('object');
    if (outer) frameExpr = outer;
  }

  const source = table.resolve(frameExpr);
  if (!source) return { ...base, failure: 'unknown-binding' };
  if (!source.path) return { ...base, failure: 'unresolvable-path' };

  const symbol = source.symbol ?? (frameExpr.type === 'identifier' ? frameExpr.text : undefined);
  const frame = resolveFrame(frameExpr, { table }) ?? undefined;
  return { ...base, source: { ...source, symbol }, frame };
}

function enclosingString(tree: Tree, offset: number): Node | null {
  const node = tree.rootNode.namedDescendantForIndex(offset);
  if (!node) return null;
  const str = nearest(node, ['string', 'concatenated_string']);
  if (!str) return null;
  // Guard against the cursor sitting just past the closing quote.
  if (offset < str.startIndex || offset > str.endIndex) return null;
  return str;
}

function stringContentRange(str: Node): [number, number] {
  const content = str.namedChildren.find((c) => c?.type === 'string_content');
  if (content) return [content.startIndex, content.endIndex];
  const start = str.namedChildren.find((c) => c?.type === 'string_start');
  const end = str.namedChildren.find((c) => c?.type === 'string_end');
  return [start ? start.endIndex : str.startIndex + 1, end ? end.startIndex : str.endIndex];
}

interface Site {
  call: Node;
  position: ArgPosition;
}

/**
 * Ascend from the string through any list/tuple/dict wrappers to the argument
 * list, working out what kind of argument position we are in on the way.
 */
function findArgumentPosition(stringNode: Node): Site | null {
  let child: Node = stringNode;
  let parent: Node | null = stringNode.parent;
  let dictRole: 'key' | 'value' | null = null;
  let keyword: string | null = null;

  while (parent && parent.type !== 'argument_list') {
    if (parent.type === 'pair') {
      dictRole = parent.childForFieldName('key')?.id === child.id ? 'key' : 'value';
    } else if (parent.type === 'keyword_argument') {
      keyword = parent.childForFieldName('name')?.text ?? null;
    } else if (!CONTAINERS.includes(parent.type)) {
      return null;
    }
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return null;

  const call = parent.parent;
  if (!call || call.type !== 'call') return null;

  if (keyword) return { call, position: { kind: 'keyword', name: keyword } };
  if (dictRole === 'value') return null;
  if (dictRole === 'key') return { call, position: { kind: 'dictKey' } };

  const { positional } = callArguments(call);
  const index = positional.findIndex((n) => n.id === child.id);
  if (index === -1) return null;
  return { call, position: { kind: 'positional', index } };
}

type CallKind =
  | { kind: 'expr-func'; spec: ArgSpec }
  | { kind: 'frame-method'; spec: ArgSpec };

function classifyCall(call: Node, table: BindingTable): CallKind | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;

  if (fn.type === 'identifier') {
    // from polars import col
    const spec = EXPR_FUNCS[fn.text];
    if (spec && table.bareExprFuncs.has(fn.text)) return { kind: 'expr-func', spec };
    return null;
  }

  if (fn.type !== 'attribute') return null;
  const attr = fn.childForFieldName('attribute')?.text;
  if (!attr) return null;

  const objName = dottedName(fn.childForFieldName('object'));
  const objRoot = objName ? objName.split('.')[0] : null;

  // pl.col(...) — a polars module function, not a method on a frame.
  if (objRoot && table.polarsAliases.has(objRoot) && EXPR_FUNCS[attr]) {
    return { kind: 'expr-func', spec: EXPR_FUNCS[attr] };
  }
  if (FRAME_METHODS[attr]) return { kind: 'frame-method', spec: FRAME_METHODS[attr] };
  return null;
}

/** If this argument is the path of `pl.read_parquet` and friends, which format? */
function pathArgumentKind(call: Node, position: ArgPosition): SourceKind | null {
  const short = lastSegment(dottedName(call.childForFieldName('function')));
  const kind = short ? SOURCE_FUNCS[short] : undefined;
  if (!kind) return null;
  if (position.kind === 'positional' && position.index === 0) return kind;
  if (position.kind === 'keyword' && PATH_KWARGS.includes(position.name)) return kind;
  return null;
}

/** True when a receiver chain bottoms out at the polars module rather than a frame. */
function rootsInPolars(expr: Node, table: BindingTable): boolean {
  let cur: Node | null = expr;
  while (cur) {
    switch (cur.type) {
      case 'identifier':
        return table.polarsAliases.has(cur.text);
      case 'call':
        cur = cur.childForFieldName('function');
        break;
      case 'attribute':
        cur = cur.childForFieldName('object');
        break;
      case 'subscript':
        cur = cur.childForFieldName('value');
        break;
      case 'parenthesized_expression':
        cur = cur.namedChildren[0] ?? null;
        break;
      default:
        return false;
    }
  }
  return false;
}

/** Nearest enclosing `something.select(...)`-shaped call above `node`. */
function enclosingFrameMethod(node: Node, table: BindingTable): Node | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'call') {
      const fn = cur.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attr = fn.childForFieldName('attribute')?.text;
        const objName = dottedName(fn.childForFieldName('object'));
        const objRoot = objName ? objName.split('.')[0] : null;
        const isPolarsModule = !!objRoot && table.polarsAliases.has(objRoot);
        if (attr && FRAME_METHODS[attr] && !isPolarsModule) return cur;
      }
    }
    cur = cur.parent;
  }
  return null;
}

/** Used by the status bar: what did we resolve for the frame at this offset? */
export function describeResolution(res: Resolution): string {
  if (res.source?.path) {
    const symbol = res.source.symbol ? `${res.source.symbol} → ` : '';
    return `${symbol}${res.source.path}`;
  }
  switch (res.failure) {
    case 'unresolvable-path': return 'path is not a literal or constant';
    case 'unknown-binding': return 'frame has no known source';
    case 'no-frame': return 'no frame at this position';
    case 'file-not-found': return 'file not found';
    case 'unsupported-scheme': return 'unsupported location';
    case 'read-failed': return 'could not read schema';
    default: return '';
  }
}

export type { SourceRef };
