import type { Node, Tree } from 'web-tree-sitter';
import type { SourceKind, SourceRef } from './types.js';
import { callArguments, dottedName, lastSegment, stringValue } from './ast.js';
import { collectConstants, constEval } from './constEval.js';

/** polars entry points that open a file, and the format each one implies. */
export const SOURCE_FUNCS: Record<string, SourceKind> = {
  read_parquet: 'parquet',
  scan_parquet: 'parquet',
  read_csv: 'csv',
  scan_csv: 'csv',
  read_csv_batched: 'csv',
  read_ipc: 'ipc',
  scan_ipc: 'ipc',
  read_feather: 'ipc',
  read_delta: 'delta',
  scan_delta: 'delta',
  scan_iceberg: 'iceberg'
};

/** Keywords that carry the path, when it is not the first positional argument. */
export const PATH_KWARGS = ['source', 'file', 'path', 'table', 'source_uri'];

/** Call-site keywords that change how the file is parsed. */
const KEPT_KWARGS = [
  'separator', 'has_header', 'skip_rows', 'skip_lines', 'comment_prefix',
  'quote_char', 'new_columns', 'encoding', 'storage_options'
];

export interface Binding {
  name: string;
  /** Byte offset of the assignment, used for "nearest preceding" lookup. */
  index: number;
  /** id of the enclosing function_definition, or null at module level. */
  scopeId: number | null;
  /** Right-hand side, resolved lazily. */
  expr: Node;
}

/** Where a reader call's path argument sits in the source, for document links. */
export interface SourceSite {
  /** Byte range of the path argument, so an editor can turn it into a link. */
  start: number;
  end: number;
  source: SourceRef;
}

export interface BindingTable {
  bindings: Binding[];
  constants: Map<string, Node>;
  /** Names bound as function parameters, per function scope — these block lookup. */
  parameters: Map<number, Set<string>>;
  /** Local names for the polars module, e.g. {"pl"}. */
  polarsAliases: Set<string>;
  /** Expression constructors imported bare: `from polars import col`. */
  bareExprFuncs: Set<string>;
  /** Every source found anywhere in the document, for the fallback offer. */
  allSources: SourceRef[];
  /** Every reader call site with a foldable path, in document order. */
  sourceSites: SourceSite[];
  resolve(node: Node): SourceRef | null;
  lookup(name: string, beforeIndex: number, scopeIds: number[]): SourceRef | null;
  /** The expression a name is bound to, for building a frame expression from it. */
  lookupBinding(name: string, beforeIndex: number, scopeIds: number[]): Node | null;
}

export function buildBindingTable(tree: Tree): BindingTable {
  const root = tree.rootNode;
  const bindings: Binding[] = [];
  const callSites: Node[] = [];
  const parameters = new Map<number, Set<string>>();
  const polarsAliases = new Set<string>();
  const bareExprFuncs = new Set<string>();

  const visit = (node: Node, scopeId: number | null) => {
    if (node.type === 'function_definition') {
      const params = new Set<string>();
      const list = node.childForFieldName('parameters');
      if (list) {
        for (const p of list.namedChildren) {
          if (!p) continue;
          if (p.type === 'identifier') params.add(p.text);
          else if (p.type === 'typed_parameter' || p.type === 'default_parameter' ||
                   p.type === 'typed_default_parameter') {
            const id = p.namedChildren.find((c) => c?.type === 'identifier');
            if (id) params.add(id.text);
          }
        }
      }
      parameters.set(node.id, params);
      const body = node.childForFieldName('body');
      if (body) for (const c of body.namedChildren) if (c) visit(c, node.id);
      return;
    }

    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left?.type === 'identifier' && right) {
        bindings.push({ name: left.text, index: node.startIndex, scopeId, expr: right });
      }
    }

    if (node.type === 'call') {
      const short = lastSegment(dottedName(node.childForFieldName('function')));
      if (short && SOURCE_FUNCS[short]) callSites.push(node);
    }

    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      collectImports(node, polarsAliases, bareExprFuncs);
    }

    for (const child of node.namedChildren) if (child) visit(child, scopeId);
  };
  visit(root, null);

  if (polarsAliases.size === 0) polarsAliases.add('pl');
  const constants = collectConstants(root);

  const memo = new Map<number, SourceRef | null>();
  const inFlight = new Set<number>();

  function lookup(name: string, beforeIndex: number, scopeIds: number[]): SourceRef | null {
    // A name bound as a parameter of an enclosing function shadows everything
    // outside it, and we have no path for it — better nothing than a wrong guess.
    for (const scopeId of scopeIds) {
      if (parameters.get(scopeId)?.has(name)) return null;
    }
    const scopes: (number | null)[] = [...scopeIds, null];
    for (const scope of scopes) {
      const inScope = bindings.filter((b) => b.name === name && b.scopeId === scope);
      if (!inScope.length) continue;
      const preceding = inScope.filter((b) => b.index < beforeIndex);
      const chosen = preceding.length ? preceding[preceding.length - 1] : inScope[0];
      return resolve(chosen.expr);
    }
    return null;
  }

  /** Same scoping rules as lookup, but returns the bound expression itself. */
  function lookupBinding(name: string, beforeIndex: number, scopeIds: number[]): Node | null {
    for (const scopeId of scopeIds) {
      if (parameters.get(scopeId)?.has(name)) return null;
    }
    const scopes: (number | null)[] = [...scopeIds, null];
    for (const scope of scopes) {
      const inScope = bindings.filter((b) => b.name === name && b.scopeId === scope);
      if (!inScope.length) continue;
      const preceding = inScope.filter((b) => b.index < beforeIndex);
      return (preceding.length ? preceding[preceding.length - 1] : inScope[0]).expr;
    }
    return null;
  }

  /** Reduce an expression to the source its frame ultimately reads from. */
  function resolve(node: Node): SourceRef | null {
    if (memo.has(node.id)) return memo.get(node.id)!;
    if (inFlight.has(node.id)) return null; // cyclic assignment
    inFlight.add(node.id);
    const result = resolveInner(node);
    inFlight.delete(node.id);
    memo.set(node.id, result);
    return result;
  }

  function resolveInner(node: Node): SourceRef | null {
    switch (node.type) {
      case 'parenthesized_expression':
        return node.namedChildren[0] ? resolve(node.namedChildren[0]!) : null;

      case 'identifier': {
        const scopeIds = enclosingScopeIds(node);
        return lookup(node.text, node.startIndex, scopeIds);
      }

      case 'attribute': {
        const obj = node.childForFieldName('object');
        return obj ? resolve(obj) : null;
      }

      case 'subscript': {
        const value = node.childForFieldName('value');
        return value ? resolve(value) : null;
      }

      case 'conditional_expression': {
        for (const child of node.namedChildren) {
          if (!child) continue;
          const found = resolve(child);
          if (found) return found;
        }
        return null;
      }

      case 'await':
        return node.namedChildren[0] ? resolve(node.namedChildren[0]!) : null;

      case 'call': {
        const fn = node.childForFieldName('function');
        const name = dottedName(fn);
        const short = lastSegment(name);

        if (short && SOURCE_FUNCS[short]) {
          return buildSourceRef(node, SOURCE_FUNCS[short]);
        }
        // pl.concat([a, b]) — the first frame decides the columns.
        if (short === 'concat') {
          const { positional } = callArguments(node);
          const first = positional[0];
          if (first && (first.type === 'list' || first.type === 'tuple')) {
            for (const item of first.namedChildren) {
              if (!item) continue;
              const found = resolve(item);
              if (found) return found;
            }
          } else if (first) {
            return resolve(first);
          }
          return null;
        }
        // Any other call: a method on something. Follow the receiver.
        if (fn?.type === 'attribute') {
          const obj = fn.childForFieldName('object');
          return obj ? resolve(obj) : null;
        }
        return null;
      }

      default:
        return null;
    }
  }

  function buildSourceRef(call: Node, kind: SourceKind): SourceRef {
    const { positional, keywords } = callArguments(call);
    const pathArg = positional[0] ??
      PATH_KWARGS.reduce<Node | null>((found, key) => found ?? keywords.get(key) ?? null, null);
    const kwargs: SourceRef['kwargs'] = {};
    for (const key of KEPT_KWARGS) {
      const value = keywords.get(key);
      if (value) kwargs[key] = literalValue(value);
    }
    return { kind, path: pathArg ? constEval(pathArg, constants) : null, kwargs };
  }

  const table: BindingTable = {
    bindings, constants, parameters, polarsAliases, bareExprFuncs,
    allSources: [], sourceSites: [], resolve, lookup, lookupBinding
  };

  for (const call of callSites) {
    const source = resolve(call);
    if (!source?.path) continue;
    const { positional, keywords } = callArguments(call);
    const pathArg = positional[0] ??
      PATH_KWARGS.reduce<Node | null>((found, key) => found ?? keywords.get(key) ?? null, null);
    if (!pathArg) continue;
    const content = pathArg.namedChildren.find((c) => c?.type === 'string_content');
    const target = content ?? pathArg;
    table.sourceSites.push({ start: target.startIndex, end: target.endIndex, source });
  }

  const seen = new Set<string>();
  for (const binding of bindings) {
    const source = resolve(binding.expr);
    if (!source?.path) continue;
    const key = `${source.kind}:${source.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    table.allSources.push({ ...source, symbol: binding.name });
  }

  return table;
}

function literalValue(node: Node): string | number | boolean | string[] | null {
  if (node.type === 'string' || node.type === 'concatenated_string') return stringValue(node);
  if (node.type === 'true') return true;
  if (node.type === 'false') return false;
  if (node.type === 'none') return null;
  if (node.type === 'integer') return Number(node.text);
  if (node.type === 'float') return Number(node.text);
  if (node.type === 'list') {
    return node.namedChildren
      .map((c) => (c ? stringValue(c) : null))
      .filter((v): v is string => v !== null);
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

function collectImports(node: Node, aliases: Set<string>, bare: Set<string>): void {
  const text = node.text;
  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name')?.text;
        const alias = child.childForFieldName('alias')?.text;
        if (name === 'polars' && alias) aliases.add(alias);
      } else if (child.type === 'dotted_name' && child.text === 'polars') {
        aliases.add('polars');
      }
    }
    return;
  }
  // from polars import col, lit  /  from polars.selectors import ...
  const moduleName = node.childForFieldName('module_name')?.text;
  if (moduleName !== 'polars') return;
  if (text.includes('*')) return;
  for (const child of node.namedChildren) {
    if (!child || child === node.childForFieldName('module_name')) continue;
    if (child.type === 'dotted_name') bare.add(child.text);
    else if (child.type === 'aliased_import') {
      const alias = child.childForFieldName('alias')?.text;
      if (alias) bare.add(alias);
    }
  }
}
