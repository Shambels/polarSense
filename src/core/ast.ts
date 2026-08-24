import type { Node } from 'web-tree-sitter';

/** `pl.scan_parquet` -> "pl.scan_parquet"; anything non-dotted -> null. */
export function dottedName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'attribute') {
    const obj = dottedName(node.childForFieldName('object'));
    const attr = node.childForFieldName('attribute')?.text;
    if (!attr) return null;
    return obj ? `${obj}.${attr}` : null;
  }
  return null;
}

/** Last segment of a dotted callee: `pl.col` -> "col". */
export function lastSegment(name: string | null): string | null {
  if (!name) return null;
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * The method a call invokes: "rename" for both `df.rename(…)` and
 * `df.select(…).rename(…)`. dottedName cannot answer the second — the receiver
 * is a call, not a name — which is exactly where chained transforms live.
 */
export function methodName(call: Node): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text ?? null;
  if (fn.type === 'identifier') return fn.text;
  return lastSegment(dottedName(fn));
}

/** Contents of a string literal node, without quotes or prefix. Null if interpolated. */
export function stringValue(node: Node): string | null {
  if (node.type !== 'string' && node.type !== 'concatenated_string') return null;
  if (node.type === 'concatenated_string') {
    let out = '';
    for (const child of node.namedChildren) {
      if (!child) continue;
      const part = stringValue(child);
      if (part === null) return null;
      out += part;
    }
    return out;
  }
  let out = '';
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'interpolation') return null;
    if (child.type === 'string_content') out += child.text;
    if (child.type === 'escape_sequence') out += unescape(child.text);
  }
  return out;
}

function unescape(seq: string): string {
  switch (seq) {
    case '\\n': return '\n';
    case '\\t': return '\t';
    case '\\r': return '\r';
    case '\\\\': return '\\';
    case '\\"': return '"';
    case "\\'": return "'";
    default: return seq;
  }
}

export interface CallArgs {
  positional: Node[];
  keywords: Map<string, Node>;
}

export function callArguments(call: Node): CallArgs {
  const list = call.childForFieldName('arguments');
  const positional: Node[] = [];
  const keywords = new Map<string, Node>();
  if (!list) return { positional, keywords };
  for (const child of list.namedChildren) {
    if (!child) continue;
    if (child.type === 'comment') continue;
    if (child.type === 'keyword_argument') {
      const name = child.childForFieldName('name')?.text;
      const value = child.childForFieldName('value');
      if (name && value) keywords.set(name, value);
    } else {
      positional.push(child);
    }
  }
  return { positional, keywords };
}

/** Nearest ancestor (inclusive) of one of the given types. */
export function nearest(node: Node | null, types: string[]): Node | null {
  let cur: Node | null = node;
  while (cur) {
    if (types.includes(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Enclosing scope nodes, innermost first, always ending with the module. */
export function scopeChain(node: Node): Node[] {
  const out: Node[] = [];
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'lambda' || cur.type === 'module') {
      out.push(cur);
    }
    cur = cur.parent;
  }
  return out;
}
