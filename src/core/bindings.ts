import type { Node, Tree } from 'web-tree-sitter';
import type { SourceKind, SourceRef } from './types.js';
import { callArguments, dottedName, lastSegment, stringValue } from './ast.js';
import { collectConstants, constEval } from './constEval.js';
import { SQL_FUNCS, sqlSource } from './sql.js';
import { collectPragmas, parameterPragma, pragmaFor, type Pragma } from './pragma.js';

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
  scan_iceberg: 'iceberg',
  // duckdb spells two of them differently; pandas and pyarrow share the rest.
  read_csv_auto: 'csv',
  parquet_scan: 'parquet'
};

/** Keywords that carry the path, when it is not the first positional argument. */
export const PATH_KWARGS = ['source', 'file', 'path', 'table', 'source_uri'];

/** Call-site keywords that change how the file is parsed. */
const KEPT_KWARGS = [
  'separator', 'has_header', 'skip_rows', 'skip_lines', 'comment_prefix',
  'quote_char', 'new_columns', 'encoding', 'storage_options'
];

/**
 * The same options, spelled the way pandas and duckdb spell them. Without this a
 * semicolon CSV read through `pd.read_csv(…, sep=";")` comes back as one column
 * whose name is the whole header row — the most confusing possible answer.
 */
const KWARG_ALIASES: Record<string, string> = {
  sep: 'separator',
  delim: 'separator',
  delimiter: 'separator',
  skiprows: 'skip_rows',
  comment: 'comment_prefix',
  quotechar: 'quote_char',
  names: 'new_columns'
};

/** A name this file imports from another module. */
export interface ImportedName {
  /** Module path exactly as written: `loaders`, `pkg.loaders`, `.loaders`, `..pkg`. */
  module: string;
  /** The name inside that module, or null when the local name *is* the module. */
  name: string | null;
  /** What it is called here. */
  local: string;
}

/**
 * An expression, and the module whose table it must be resolved against.
 *
 * The second half is the whole point: a frame built in `loaders.py` is a node in
 * `loaders.py`'s tree, and resolving it against the *importing* file's bindings
 * would look up the wrong names entirely.
 */
export interface Definition {
  /** Candidates in order — a `def` with several `return`s offers each of them. */
  exprs: Node[];
  table: BindingTable;
}

/** Supplies the binding table of another module. Implemented by the I/O layer. */
export interface ModuleLoader {
  tableFor(module: string): BindingTable | null;
}

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
  /** Local names for the polars.selectors module, e.g. {"cs"}. */
  selectorAliases: Set<string>;
  /** Selectors imported bare: `from polars.selectors import numeric`. */
  bareSelectorFuncs: Set<string>;
  /** Every source found anywhere in the document, for the fallback offer. */
  allSources: SourceRef[];
  /** Every reader call site with a foldable path, in document order. */
  sourceSites: SourceSite[];
  /** Names imported from other modules, in document order. */
  imports: ImportedName[];
  /** `# polarsense: …` escape hatches, by the row each comment sits on. */
  pragmas: Map<number, Pragma>;
  resolve(node: Node): SourceRef | null;
  lookup(name: string, beforeIndex: number, scopeIds: number[]): SourceRef | null;
  /**
   * What a name stands for: the expression bound to it, or — when `called` — the
   * expressions a `def` of that name returns. Follows imports into other modules,
   * which is why the answer carries the table it belongs to.
   */
  resolveName(
    name: string, beforeIndex: number, scopeIds: number[], called: boolean
  ): Definition | null;
  /** The same, for a call node: `load()`, `loaders.load()`. */
  callDefinition(call: Node): Definition | null;
  /** The table of a module imported here under this local name, if we have it. */
  moduleFor(alias: string | null): BindingTable | null;
}

export function buildBindingTable(tree: Tree, loader?: ModuleLoader): BindingTable {
  const root = tree.rootNode;
  const bindings: Binding[] = [];
  const callSites: Node[] = [];
  const parameters = new Map<number, Set<string>>();
  const polarsAliases = new Set<string>();
  const bareExprFuncs = new Set<string>();
  const selectorAliases = new Set<string>();
  const bareSelectorFuncs = new Set<string>();
  const imports: ImportedName[] = [];
  /** Module-level `def`s by name: calling one of these can produce a frame. */
  const functions = new Map<string, Node>();

  const visit = (node: Node, scopeId: number | null) => {
    if (node.type === 'function_definition') {
      // Only module-level defs. A method needs an instance we cannot follow.
      const defName = node.childForFieldName('name')?.text;
      if (defName && node.parent?.type === 'module') functions.set(defName, node);
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
      if (short && (SOURCE_FUNCS[short] || SQL_FUNCS.has(short))) callSites.push(node);
    }

    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      collectImports(node, { polarsAliases, bareExprFuncs, selectorAliases, bareSelectorFuncs, imports });
    }

    for (const child of node.namedChildren) if (child) visit(child, scopeId);
  };
  visit(root, null);

  if (polarsAliases.size === 0) polarsAliases.add('pl');
  const constants = collectConstants(root);
  const pragmas = collectPragmas(tree);

  const memo = new Map<number, SourceRef | null>();
  const inFlight = new Set<number>();

  const importsByLocal = new Map<string, ImportedName>();

  function lookup(name: string, beforeIndex: number, scopeIds: number[]): SourceRef | null {
    return fromDefinition(resolveName(name, beforeIndex, scopeIds, false));
  }

  function resolveName(
    name: string, beforeIndex: number, scopeIds: number[], called: boolean
  ): Definition | null {
    // A name bound as a parameter of an enclosing function shadows everything
    // outside it, and we have no path for it — better nothing than a wrong guess.
    for (const scopeId of scopeIds) {
      if (parameters.get(scopeId)?.has(name)) return null;
    }

    if (called) {
      const fn = functions.get(name);
      if (fn) {
        const exprs = returnExpressions(fn);
        return exprs.length ? { exprs, table } : null;
      }
    } else {
      const scopes: (number | null)[] = [...scopeIds, null];
      for (const scope of scopes) {
        const inScope = bindings.filter((b) => b.name === name && b.scopeId === scope);
        if (!inScope.length) continue;
        const preceding = inScope.filter((b) => b.index < beforeIndex);
        const chosen = preceding.length ? preceding[preceding.length - 1] : inScope[0];
        return { exprs: [chosen.expr], table };
      }
    }

    // Not defined here — but it may have been imported. The other module answers
    // for its own module level, so there is no cursor position to respect.
    const imported = importsByLocal.get(name);
    if (!imported?.name || !loader) return null;
    const other = loader.tableFor(imported.module);
    if (!other || other === table) return null;
    return other.resolveName(imported.name, Number.MAX_SAFE_INTEGER, [], called);
  }

  /** The definition a call resolves to: `load()`, `loaders.load()`. */
  function callDefinition(call: Node): Definition | null {
    const fn = call.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
      return resolveName(fn.text, call.startIndex, enclosingScopeIds(call), true);
    }
    if (fn.type === 'attribute') {
      const attr = fn.childForFieldName('attribute')?.text;
      const module = moduleFor(dottedName(fn.childForFieldName('object')));
      if (!attr || !module) return null;
      return module.resolveName(attr, Number.MAX_SAFE_INTEGER, [], true);
    }
    return null;
  }

  function moduleFor(alias: string | null): BindingTable | null {
    if (!alias || !loader) return null;
    const imported = importsByLocal.get(alias);
    // `import loaders` binds the module itself; `from x import y` binds a name.
    if (!imported || imported.name !== null) return null;
    const other = loader.tableFor(imported.module);
    return other === table ? null : other;
  }

  /** First of a definition's candidates that reduces to a source. */
  function fromDefinition(def: Definition | null): SourceRef | null {
    if (!def) return null;
    for (const expr of def.exprs) {
      const found = def.table.resolve(expr);
      if (found) return found;
    }
    return null;
  }

  /** Reduce an expression to the source its frame ultimately reads from. */
  function resolve(node: Node): SourceRef | null {
    if (memo.has(node.id)) return memo.get(node.id)!;
    if (inFlight.has(node.id)) return null; // cyclic assignment
    inFlight.add(node.id);
    const result = withPragma(node, resolveInner(node));
    inFlight.delete(node.id);
    memo.set(node.id, result);
    return result;
  }

  /**
   * The escape hatch, applied only where the code itself came up short: no
   * source at all, or a reader whose path would not fold. In the second case the
   * call still knows the format and its options — only the path was missing.
   */
  function withPragma(node: Node, found: SourceRef | null): SourceRef | null {
    if (found?.path) return found;
    const pragma = pragmaFor(node, pragmas);
    if (!pragma) return found;
    return found ? { ...found, path: pragma.path } : pragma;
  }

  function resolveInner(node: Node): SourceRef | null {
    switch (node.type) {
      case 'parenthesized_expression':
        return node.namedChildren[0] ? resolve(node.namedChildren[0]!) : null;

      case 'identifier': {
        const scopeIds = enclosingScopeIds(node);
        // `def report(df):  # polarsense: data/sales.parquet` — a parameter is
        // the one binding that has nowhere else to get a path from.
        return lookup(node.text, node.startIndex, scopeIds)
          ?? parameterPragma(node, pragmas);
      }

      case 'attribute': {
        // `loaders.sales` — a frame another module exports.
        const attr = node.childForFieldName('attribute')?.text;
        const module = moduleFor(dottedName(node.childForFieldName('object')));
        if (attr && module) {
          const found = fromDefinition(
            module.resolveName(attr, Number.MAX_SAFE_INTEGER, [], false)
          );
          if (found) return found;
        }
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
        // `duckdb.sql("SELECT * FROM 'sales.parquet'")` — the path is in the SQL.
        if (short && SQL_FUNCS.has(short)) {
          const fromSql = sqlSource(node);
          if (fromSql) return fromSql.source;
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
        // `load_sales()` — a function, here or in another module, that returns a
        // frame. Its `return` expression is resolved in its own module.
        const returned = fromDefinition(callDefinition(node));
        if (returned) return returned;
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
    for (const [key, value] of keywords) {
      const name = KWARG_ALIASES[key] ?? key;
      if (!KEPT_KWARGS.includes(name) || name in kwargs) continue;
      kwargs[name] = literalValue(value);
    }
    // pandas says `header=None` where polars says `has_header=False`, and
    // `header=0` where polars says nothing at all.
    const header = keywords.get('header');
    if (header && !('has_header' in kwargs)) kwargs.has_header = literalValue(header) !== null;
    return { kind, path: pathArg ? constEval(pathArg, constants) : null, kwargs };
  }

  const table: BindingTable = {
    bindings, constants, parameters, polarsAliases, bareExprFuncs,
    selectorAliases, bareSelectorFuncs, imports, pragmas,
    allSources: [], sourceSites: [],
    resolve, lookup, resolveName, callDefinition, moduleFor
  };
  for (const imported of imports) importsByLocal.set(imported.local, imported);

  for (const call of callSites) {
    const source = resolve(call);
    if (!source?.path) continue;

    // A path inside a SQL string is a range within that string, not an argument.
    const short = lastSegment(dottedName(call.childForFieldName('function')));
    if (short && SQL_FUNCS.has(short)) {
      const fromSql = sqlSource(call);
      if (!fromSql) continue;
      const content = fromSql.sql.namedChildren.find((c) => c?.type === 'string_content');
      const start = (content ? content.startIndex : fromSql.sql.startIndex + 1) + fromSql.index;
      table.sourceSites.push({ start, end: start + fromSql.source.path!.length, source });
      continue;
    }

    const { positional, keywords } = callArguments(call);
    const pathArg = positional[0] ??
      PATH_KWARGS.reduce<Node | null>((found, key) => found ?? keywords.get(key) ?? null, null);
    if (!pathArg) continue;
    const content = pathArg.namedChildren.find((c) => c?.type === 'string_content');
    const target = content ?? pathArg;
    table.sourceSites.push({ start: target.startIndex, end: target.endIndex, source });
  }

  // A pragma's path is ctrl-clickable like any other, which is the cheapest way
  // to notice you have typed the wrong one.
  for (const pragma of pragmas.values()) {
    table.sourceSites.push({ start: pragma.start, end: pragma.end, source: pragma.source });
  }
  table.sourceSites.sort((a, b) => a.start - b.start);

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

interface ImportNames {
  polarsAliases: Set<string>;
  bareExprFuncs: Set<string>;
  selectorAliases: Set<string>;
  bareSelectorFuncs: Set<string>;
  imports: ImportedName[];
}

/**
 * The names a file imports, without building a whole binding table — the module
 * loader needs this before it can know which files to read.
 */
export function readImports(tree: Tree): ImportedName[] {
  const imports: ImportedName[] = [];
  const names: ImportNames = {
    polarsAliases: new Set(), bareExprFuncs: new Set(),
    selectorAliases: new Set(), bareSelectorFuncs: new Set(), imports
  };
  const nodes = tree.rootNode.descendantsOfType(['import_statement', 'import_from_statement']);
  for (const node of nodes) if (node) collectImports(node, names);
  return imports;
}

/** The expressions a function returns, ignoring nested functions and `return None`. */
function returnExpressions(fn: Node): Node[] {
  const out: Node[] = [];
  const body = fn.childForFieldName('body');
  if (!body) return out;
  const visit = (node: Node) => {
    if (node.type === 'function_definition' || node.type === 'lambda') return;
    if (node.type === 'return_statement') {
      const value = node.namedChildren.find((c) => c && c.type !== 'comment');
      if (value && value.type !== 'none') out.push(value);
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  for (const child of body.namedChildren) if (child) visit(child);
  return out;
}

const SELECTORS_MODULE = 'polars.selectors';

function collectImports(node: Node, names: ImportNames): void {
  const text = node.text;
  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'aliased_import') {
        // import polars as pl  /  import polars.selectors as cs
        const name = child.childForFieldName('name')?.text;
        const alias = child.childForFieldName('alias')?.text;
        if (!alias || !name) continue;
        if (name === 'polars') names.polarsAliases.add(alias);
        else if (name === SELECTORS_MODULE) names.selectorAliases.add(alias);
        names.imports.push({ module: name, name: null, local: alias });
      } else if (child.type === 'dotted_name') {
        if (child.text === 'polars') names.polarsAliases.add('polars');
        else if (child.text === SELECTORS_MODULE) {
          names.polarsAliases.add('polars');
          names.selectorAliases.add(SELECTORS_MODULE);
        }
        // `import pkg.loaders` is used as `pkg.loaders.x`, so that is the name.
        names.imports.push({ module: child.text, name: null, local: child.text });
      }
    }
    return;
  }
  // from polars import col, lit  /  from polars import selectors as cs
  // from polars.selectors import numeric, by_name  /  from loaders import sales
  collectImportedNames(node, names.imports);
  const moduleName = node.childForFieldName('module_name')?.text;
  const moduleId = node.childForFieldName('module_name')?.id;
  if (moduleName !== 'polars' && moduleName !== SELECTORS_MODULE) return;
  if (text.includes('*')) return;
  const fromSelectors = moduleName === SELECTORS_MODULE;
  for (const child of node.namedChildren) {
    if (!child || child.id === moduleId) continue;
    let name: string | null = null;
    let alias: string | null = null;
    if (child.type === 'dotted_name') name = child.text;
    else if (child.type === 'aliased_import') {
      name = child.childForFieldName('name')?.text ?? null;
      alias = child.childForFieldName('alias')?.text ?? null;
    }
    if (!name) continue;
    const local = alias ?? name;
    if (fromSelectors) names.bareSelectorFuncs.add(local);
    else if (name === 'selectors') names.selectorAliases.add(local);
    else names.bareExprFuncs.add(local);
  }
}

/** Everything a `from x import y` / `import x` statement brings into scope. */
function collectImportedNames(node: Node, imports: ImportedName[]): void {
  const module = node.childForFieldName('module_name')?.text;
  const moduleId = node.childForFieldName('module_name')?.id;
  if (!module || node.text.includes('*')) return;
  for (const child of node.namedChildren) {
    if (!child || child.id === moduleId) continue;
    if (child.type === 'dotted_name') {
      imports.push({ module, name: child.text, local: child.text });
    } else if (child.type === 'aliased_import') {
      const name = child.childForFieldName('name')?.text;
      const alias = child.childForFieldName('alias')?.text;
      if (name && alias) imports.push({ module, name, local: alias });
    }
  }
}
