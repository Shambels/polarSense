import type { Node, Tree } from 'web-tree-sitter';
import type { Resolution, SourceKind, SourceRef } from './types.js';
import { PATH_KWARGS, SOURCE_FUNCS, type BindingTable } from './bindings.js';
import { callArguments, dottedName, lastSegment, methodName, nearest, stringValue } from './ast.js';
import { resolveFrame, type FrameExpr } from './frame.js';
import {
  EXPR_FUNCS, FRAGMENT_METHODS, FRAME_METHODS, RIGHT_FRAME_KWARGS, specAccepts,
  type ArgPosition, type ArgSpec
} from './triggerSites.js';
import { PARTIAL_SELECTORS, SELECTOR_FUNCS, isSelectorNamespace } from './selectors.js';
import {
  SQL_FUNCS, matchesQualifier, sqlColumnPosition, sqlTables, sqlText, type SqlTable
} from './sql.js';

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

  // A SQL string is a whole little language of its own, and the tables it reads
  // are named inside it rather than by the call.
  const sqlCall = findSqlCall(stringNode);
  if (sqlCall) {
    const resolved = resolveSqlSite(sqlCall, stringNode, offset, table, base);
    if (resolved) return resolved;
  }

  // `df["region"]` is a subscript, not a call, so the argument walk never sees it.
  const subscriptReceiver = findSubscriptSite(stringNode);
  if (subscriptReceiver) {
    const resolved = resolveReceiver(subscriptReceiver, table);
    // A dict subscript — cfg["path"] — is structurally identical to a frame one.
    // If the receiver is not a frame we know, say nothing at all rather than
    // letting the all-schemas fallback offer column names inside every dict.
    if (!resolved) return { ...base, failure: 'not-a-column-site' };
    return { ...base, ...resolved };
  }

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

  const resolved = resolveReceiver(frameExpr, table);
  if (!resolved) {
    const source = table.resolve(frameExpr);
    if (!source) return { ...base, failure: 'unknown-binding' };
    return { ...base, failure: 'unresolvable-path' };
  }
  // A fragment holds several names, so only the one under the cursor is replaced.
  return spec.partial
    ? { ...base, ...wordRange(stringNode, offset, base), ...resolved, partial: true }
    : { ...base, ...resolved };
}

/** The call whose SQL argument this string is, if it is one. */
function findSqlCall(stringNode: Node): Node | null {
  const parent = stringNode.parent;
  const list = parent?.type === 'keyword_argument' ? parent.parent : parent;
  if (list?.type !== 'argument_list') return null;
  const call = list.parent;
  if (!call || call.type !== 'call') return null;
  const short = methodName(call);
  if (!short || !SQL_FUNCS.has(short)) return null;
  const { positional, keywords } = callArguments(call);
  const arg = positional[0] ?? keywords.get('query') ?? keywords.get('sql');
  return arg?.id === stringNode.id ? call : null;
}

/**
 * A cursor inside SQL. Returns null when the string holds no FROM clause at all,
 * which is how `df.query("revenue > 100")` — a pandas expression, not SQL —
 * falls through to being read as an ordinary argument.
 */
function resolveSqlSite(
  call: Node, stringNode: Node, offset: number, table: BindingTable, base: Resolution
): Resolution | null {
  const raw = sqlText(stringNode);
  if (!raw) return null;
  const tables = sqlTables(raw.text);
  if (!tables.length) return null;

  const position = sqlColumnPosition(raw.text, offset - raw.base, tables);
  if (!position) return { ...base, failure: 'not-a-column-site' };

  const range = {
    contentStart: raw.base + position.wordStart,
    contentEnd: raw.base + position.wordEnd
  };
  const wanted = position.qualifier
    ? tables.filter((ref) => matchesQualifier(ref, position.qualifier as string))
    : tables;

  const parts: { source: SourceRef; frame?: FrameExpr }[] = [];
  for (const ref of wanted) {
    const resolved = resolveSqlTable(ref, call, table);
    if (resolved) parts.push(resolved);
  }
  if (!parts.length) return { ...base, ...range, failure: 'unknown-binding' };

  return {
    ...base,
    ...range,
    partial: true,
    source: parts[0].source,
    frame: unionFrames(parts)
  };
}

/** The frame a table reference names: a file, the receiver, or a Python name. */
function resolveSqlTable(
  ref: SqlTable, call: Node, table: BindingTable
): { source: SourceRef; frame?: FrameExpr } | null {
  // `FROM 'sales.parquet'` and `FROM read_parquet('sales.parquet')`.
  if (ref.path) {
    return { source: { kind: ref.kind ?? 'parquet', path: ref.path, kwargs: {} } };
  }
  // `FROM self` — polars' name for the frame `.sql(…)` was called on.
  if (ref.name.toLowerCase() === 'self') {
    const receiver = call.childForFieldName('function')?.childForFieldName('object');
    return receiver ? resolveReceiver(receiver, table) : null;
  }
  // A frame registered with pl.SQLContext, then a plain name in the file. The
  // second is how `pl.sql("SELECT * FROM df")` finds `df` at all.
  const registered = registeredFrames(call, table).get(ref.name);
  if (registered) return resolveReceiver(registered, table);

  const definition = table.resolveName(ref.name, call.startIndex, enclosingScopeIds(call), false);
  for (const expr of definition?.exprs ?? []) {
    const found = resolveReceiver(expr, definition!.table);
    if (found) return { ...found, source: { ...found.source, symbol: ref.name } };
  }
  return null;
}

/**
 * Several tables in one statement, as one frame. The join carries no keys — SQL
 * says which column belongs to which table and this scan does not read that far —
 * so the answer comes back marked uncertain, which is the truth.
 */
function unionFrames(parts: { source: SourceRef; frame?: FrameExpr }[]): FrameExpr {
  const frames = parts.map((part): FrameExpr =>
    part.frame ?? { kind: 'source', source: part.source });
  return frames.reduce((left, right): FrameExpr => ({
    kind: 'join', left, right, on: { shared: [], unknown: true }, how: 'inner', suffix: ''
  }));
}

/** Frames given a name by `pl.SQLContext(sales=df)` or `.register("sales", df)`. */
function registeredFrames(call: Node, table: BindingTable): Map<string, Node> {
  const found = new Map<string, Node>();
  let cur: Node | null = call.childForFieldName('function')?.childForFieldName('object') ?? null;

  for (let depth = 0; cur && depth < 16; depth++) {
    if (cur.type === 'parenthesized_expression') {
      cur = cur.namedChildren[0] ?? null;
      continue;
    }
    if (cur.type === 'identifier') {
      const definition = table.resolveName(
        cur.text, cur.startIndex, enclosingScopeIds(cur), false
      );
      cur = definition?.exprs[0] ?? null;
      continue;
    }
    if (cur.type !== 'call') break;

    const short = methodName(cur);
    const { positional, keywords } = callArguments(cur);
    if (short === 'SQLContext' || short === 'register_many') {
      collectFrameNames(positional[0] ?? keywords.get('frames'), found);
      for (const [name, value] of keywords) {
        if (name !== 'frames' && !found.has(name)) found.set(name, value);
      }
    } else if (short === 'register') {
      const name = positional[0] ? stringValue(positional[0]) : null;
      if (name && positional[1] && !found.has(name)) found.set(name, positional[1]);
    }
    cur = cur.childForFieldName('function')?.childForFieldName('object') ?? null;
  }
  return found;
}

function collectFrameNames(node: Node | undefined, into: Map<string, Node>): void {
  if (node?.type !== 'dictionary') return;
  for (const pair of node.namedChildren) {
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    const name = key ? stringValue(key) : null;
    if (name && value && !into.has(name)) into.set(name, value);
  }
}

const WORD_CHAR = /[A-Za-z_0-9$]/;

/** The identifier under the cursor within a string, rather than the whole string. */
function wordRange(
  stringNode: Node, offset: number, base: Resolution
): { contentStart: number; contentEnd: number } {
  const raw = sqlText(stringNode);
  if (!raw) return { contentStart: base.contentStart, contentEnd: base.contentEnd };
  let start = Math.max(0, Math.min(raw.text.length, offset - raw.base));
  let end = start;
  while (start > 0 && WORD_CHAR.test(raw.text[start - 1])) start--;
  while (end < raw.text.length && WORD_CHAR.test(raw.text[end])) end++;
  return { contentStart: raw.base + start, contentEnd: raw.base + end };
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

/** Turn a receiver expression into the source it reads and the frame it is. */
function resolveReceiver(
  expr: Node,
  table: BindingTable
): { source: SourceRef; frame?: FrameExpr } | null {
  const source = table.resolve(expr);
  if (!source?.path) return null;
  const symbol = source.symbol ?? (expr.type === 'identifier' ? expr.text : undefined);
  return {
    source: { ...source, symbol },
    frame: resolveFrame(expr, { table }) ?? undefined
  };
}

/**
 * The receiver of a subscript whose index is this string, or null when the
 * string is not a subscript index at all.
 */
function findSubscriptSite(stringNode: Node): Node | null {
  let child: Node = stringNode;
  let parent: Node | null = stringNode.parent;

  while (parent) {
    if (parent.type === 'subscript') {
      // `frames["a"]["b"]` — the inner subscript is the *value*, not an index.
      if (parent.childForFieldName('value')?.id === child.id) return null;
      return parent.childForFieldName('value');
    }
    // df[["a", "b"]] and df["a", "b"] both wrap the name before the subscript.
    if (!CONTAINERS.includes(parent.type)) return null;
    child = parent;
    parent = parent.parent;
  }
  return null;
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

  // Checked before the keyword: `rename(columns={"old": "new"})` is a dict key
  // *and* a keyword argument, and only the key half is a column that exists.
  if (dictRole === 'value') return null;
  if (dictRole === 'key') return { call, position: { kind: 'dictKey', keyword } };
  if (keyword) return { call, position: { kind: 'keyword', name: keyword } };

  const { positional } = callArguments(call);
  const index = positional.findIndex((n) => n.id === child.id);
  if (index === -1) return null;
  return { call, position: { kind: 'positional', index } };
}

type CallKind =
  | { kind: 'expr-func'; spec: ArgSpec; partial?: boolean }
  | { kind: 'frame-method'; spec: ArgSpec; partial?: boolean };

function classifyCall(call: Node, table: BindingTable): CallKind | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;

  if (fn.type === 'identifier') {
    // from polars import col
    const spec = EXPR_FUNCS[fn.text];
    if (spec && table.bareExprFuncs.has(fn.text)) return { kind: 'expr-func', spec };
    // from polars.selectors import by_name
    const selector = SELECTOR_FUNCS[fn.text];
    if (selector && table.bareSelectorFuncs.has(fn.text)) {
      return { kind: 'expr-func', spec: selector, partial: PARTIAL_SELECTORS.has(fn.text) };
    }
    return null;
  }

  if (fn.type !== 'attribute') return null;
  const attr = fn.childForFieldName('attribute')?.text;
  if (!attr) return null;

  const objName = dottedName(fn.childForFieldName('object'));
  const objRoot = objName ? objName.split('.')[0] : null;

  // cs.by_name(...) — checked first, because `pl.selectors.first` and `pl.first`
  // share a short name and are not the same thing.
  if (isSelectorNamespace(objName, table) && SELECTOR_FUNCS[attr]) {
    return {
      kind: 'expr-func',
      spec: SELECTOR_FUNCS[attr],
      partial: PARTIAL_SELECTORS.has(attr)
    };
  }

  // pl.col(...) — a polars module function, not a method on a frame.
  if (objRoot && table.polarsAliases.has(objRoot) && EXPR_FUNCS[attr]) {
    return { kind: 'expr-func', spec: EXPR_FUNCS[attr] };
  }
  if (FRAME_METHODS[attr]) {
    return {
      kind: 'frame-method',
      spec: FRAME_METHODS[attr],
      partial: FRAGMENT_METHODS.has(attr)
    };
  }
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
        return table.polarsAliases.has(cur.text) || table.selectorAliases.has(cur.text);
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
        const isModule = (!!objRoot && table.polarsAliases.has(objRoot)) ||
          isSelectorNamespace(objName, table);
        if (attr && FRAME_METHODS[attr] && !isModule) return cur;
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
