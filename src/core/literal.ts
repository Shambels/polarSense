import type { Node } from 'web-tree-sitter';
import type { Column, SourceRef } from './types.js';
import { callArguments, dottedName, stringValue } from './ast.js';
import { constEval } from './constEval.js';
import type { BindingTable } from './bindings.js';

/**
 * Frames built from data written in the source — `pl.DataFrame({"a": [1, 2]})`.
 *
 * There is no file to read here, and none is needed: the column names are the
 * dict's keys, and the call is as much a schema as a parquet footer is. What
 * this does not do is run anything. A key that is not a literal (or a constant
 * that folds to one) is not guessed at; it drops certainty, exactly as an
 * unmodelled transform does.
 */

type Flavour = 'polars' | 'pandas';

/** polars constructors that take column-oriented data or a list of rows. */
const POLARS_CONSTRUCTORS = new Set(['DataFrame', 'LazyFrame', 'from_dict', 'from_dicts']);

/**
 * Which library's constructor this call is, if it is one. Matched against the
 * names the file actually imports: `DataFrame(…)` is a polars frame only when
 * `from polars import DataFrame` says so, and spark's `createDataFrame` or any
 * other class of that name is not.
 */
export function frameConstructor(call: Node, table: BindingTable): Flavour | null {
  const name = dottedName(call.childForFieldName('function'));
  if (!name) return null;
  const dot = name.indexOf('.');
  if (dot === -1) {
    if (POLARS_CONSTRUCTORS.has(name) && table.bareExprFuncs.has(name)) return 'polars';
    if (name === 'DataFrame' && importsFrom(table, 'pandas', 'DataFrame')) return 'pandas';
    return null;
  }
  const module = name.slice(0, dot);
  const member = name.slice(dot + 1);
  if (table.polarsAliases.has(module) && POLARS_CONSTRUCTORS.has(member)) return 'polars';
  if (pandasAliases(table).has(module) &&
      (member === 'DataFrame' || member === 'DataFrame.from_dict')) {
    return 'pandas';
  }
  return null;
}

/**
 * The source a constructor call stands for, or null when the call does not say
 * which columns it makes — a list of lists with no `schema=`, another object
 * handed in whole, nothing at all.
 */
export function inlineSource(call: Node, table: BindingTable): SourceRef | null {
  const flavour = frameConstructor(call, table);
  if (!flavour) return null;
  const callee = dottedName(call.childForFieldName('function')) ?? 'DataFrame';
  const shape = flavour === 'polars' ? polarsShape(call, table) : pandasShape(call, table);
  if (!shape || !shape.columns.length) return null;
  return {
    kind: 'inline',
    // A label rather than a path: it is what the completion detail and the hover
    // show as the place the columns came from.
    path: `${callee}(…)`,
    kwargs: {},
    inline: shape
  };
}

interface Shape {
  columns: Column[];
  certain: boolean;
  rowCount?: number;
}

function polarsShape(call: Node, table: BindingTable): Shape | null {
  const { positional, keywords } = callArguments(call);
  const data = positional[0] ?? keywords.get('data') ?? null;
  const schemaArg = positional[1] ?? keywords.get('schema') ?? null;

  const fromData = data ? dataShape(follow(data, table), table, true) : null;
  // `schema=` names the columns outright, and wins over the data's own names —
  // polars renames positionally when the two disagree.
  const fromSchema = schemaArg ? schemaShape(follow(schemaArg, table), table) : null;

  let shape: Shape | null;
  if (fromSchema) {
    shape = { ...fromSchema, rowCount: fromData?.rowCount };
    if (fromData && fromSchema.columns.every((c) => !c.dtype)) {
      // A bare list of names keeps the dtypes the data implied, by position.
      shape.columns = fromSchema.columns.map((c, i) => ({
        ...c, dtype: fromData.columns[i]?.dtype ?? ''
      }));
    }
  } else if (schemaArg && fromData) {
    // A schema we cannot read may rename every column; keep the data's names,
    // but do not let the typo check accuse anything on their strength.
    shape = { ...fromData, certain: false };
  } else {
    shape = fromData;
  }
  if (!shape) return null;

  const overrides = keywords.get('schema_overrides');
  if (overrides?.type === 'dictionary') {
    const byName = new Map<string, string>();
    for (const pair of overrides.namedChildren) {
      if (pair?.type !== 'pair') continue;
      const key = keyName(pair.childForFieldName('key'), table);
      const value = pair.childForFieldName('value');
      if (key !== null && value) byName.set(key, polarsDtype(value));
    }
    shape.columns = shape.columns.map((c) =>
      byName.has(c.name) ? { ...c, dtype: byName.get(c.name)! } : c);
  }
  return shape;
}

function pandasShape(call: Node, table: BindingTable): Shape | null {
  const { positional, keywords } = callArguments(call);
  const isFromDict = dottedName(call.childForFieldName('function'))?.endsWith('.from_dict');
  // `orient="index"` turns the keys into rows; only the default reads as columns.
  if (isFromDict && (keywords.has('orient') || positional[1])) return null;
  const data = positional[0] ?? keywords.get('data') ?? null;
  const columnsArg = (isFromDict ? positional[3] : positional[2]) ?? keywords.get('columns');

  // pandas dtypes are not polars dtypes; leaving them blank is more honest than
  // showing `i64` for what pandas will call `int64`.
  const fromData = data ? dataShape(follow(data, table), table, false) : null;
  if (columnsArg) {
    const names = nameList(follow(columnsArg, table), table);
    if (names) return { columns: names.map((name) => ({ name, dtype: '' })), certain: true, rowCount: fromData?.rowCount };
    return fromData ? { ...fromData, certain: false } : null;
  }
  return fromData;
}

/** Column names from the data argument: a dict of columns, or a list of row dicts. */
function dataShape(node: Node, table: BindingTable, typed: boolean): Shape | null {
  if (node.type === 'dictionary') {
    const columns: Column[] = [];
    let certain = true;
    const lengths = new Set<number>();
    for (const pair of node.namedChildren) {
      if (!pair || pair.type === 'comment') continue;
      // `{**base, "x": …}` — whatever base holds is a column we cannot name.
      if (pair.type !== 'pair') { certain = false; continue; }
      const name = keyName(pair.childForFieldName('key'), table);
      if (name === null) { certain = false; continue; }
      const value = pair.childForFieldName('value');
      if (value?.type === 'list' || value?.type === 'tuple') {
        lengths.add(value.namedChildren.filter((c) => c && c.type !== 'comment').length);
      } else {
        lengths.add(-1);
      }
      upsert(columns, { name, dtype: typed && value ? valuesDtype(value) : '' });
    }
    const rowCount = lengths.size === 1 && !lengths.has(-1) ? [...lengths][0] : undefined;
    return { columns, certain, rowCount };
  }

  if (node.type === 'list' || node.type === 'tuple') {
    const rows = node.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');
    if (!rows.length) return null;
    // A list of lists or of scalars is positional — polars calls those columns
    // `column_0…`, or reads them as rows, depending on `orient` and on the data.
    // That is a guess this does not make; `schema=` is how to say.
    if (!rows.every((r) => r.type === 'dictionary')) return null;
    const columns: Column[] = [];
    let certain = true;
    for (const row of rows) {
      const shape = dataShape(row, table, false);
      if (!shape) continue;
      certain &&= shape.certain;
      for (const column of shape.columns) upsert(columns, column);
    }
    return { columns, certain, rowCount: rows.length };
  }

  return null;
}

/** `schema=` as a dict of dtypes, a list of names, or a list of (name, dtype) pairs. */
function schemaShape(node: Node, table: BindingTable): Shape | null {
  if (node.type === 'dictionary') {
    const columns: Column[] = [];
    let certain = true;
    for (const pair of node.namedChildren) {
      if (!pair || pair.type === 'comment') continue;
      if (pair.type !== 'pair') { certain = false; continue; }
      const name = keyName(pair.childForFieldName('key'), table);
      if (name === null) { certain = false; continue; }
      const value = pair.childForFieldName('value');
      upsert(columns, { name, dtype: value ? polarsDtype(value) : '' });
    }
    return columns.length ? { columns, certain } : null;
  }
  if (node.type === 'list' || node.type === 'tuple') {
    const columns: Column[] = [];
    for (const item of node.namedChildren) {
      if (!item || item.type === 'comment') continue;
      if (item.type === 'tuple' && item.namedChildren.length === 2) {
        const name = keyName(item.namedChildren[0], table);
        if (name === null) return null;
        upsert(columns, { name, dtype: polarsDtype(item.namedChildren[1]!) });
        continue;
      }
      const name = keyName(item, table);
      if (name === null) return null;
      upsert(columns, { name, dtype: '' });
    }
    return columns.length ? { columns, certain: true } : null;
  }
  return null;
}

function nameList(node: Node, table: BindingTable): string[] | null {
  if (node.type !== 'list' && node.type !== 'tuple') return null;
  const out: string[] = [];
  for (const item of node.namedChildren) {
    if (!item || item.type === 'comment') continue;
    const name = keyName(item, table);
    if (name === null) return null;
    out.push(name);
  }
  return out;
}

/** A dict key or schema entry as a column name: a literal, or a constant that folds to one. */
function keyName(node: Node | null, table: BindingTable): string | null {
  if (!node) return null;
  const literal = stringValue(node);
  if (literal !== null) return literal;
  if (node.type !== 'identifier') return null;
  // constEval is a *path* folder, and turns '' into '.'. A column cannot be
  // named by a constant that is not a string anyway.
  const folded = constEval(node, table.constants);
  return folded === '.' ? null : folded;
}

/**
 * `data = {…}` on one line and `pl.DataFrame(data)` on the next is the most
 * common way these are written, so a bare name is followed to what it is bound
 * to — once, and only to a literal; anything else is returned as it was.
 */
function follow(node: Node, table: BindingTable): Node {
  if (node.type !== 'identifier') return node;
  const def = table.resolveName(node.text, node.startIndex, enclosingScopeIds(node), false);
  const expr = def?.exprs[0];
  if (!expr || def.table !== table) return node;
  return ['dictionary', 'list', 'tuple'].includes(expr.type) ? expr : node;
}

function upsert(columns: Column[], column: Column): void {
  // A repeated key is one column in a dict, and the later value is the one kept.
  const at = columns.findIndex((c) => c.name === column.name);
  if (at === -1) columns.push(column);
  else if (column.dtype) columns[at] = column;
}

/** The dtype polars infers for a list of literals, or '' when it is not that simple. */
function valuesDtype(node: Node): string {
  const items = node.type === 'list' || node.type === 'tuple'
    ? node.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment')
    : [node];
  const kinds = new Set<string>();
  for (const item of items) {
    const kind = literalKind(item);
    if (!kind) return '';
    if (kind !== 'null') kinds.add(kind);
  }
  if (!items.length) return '';
  if (!kinds.size) return 'null';
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size === 2 && kinds.has('i64') && kinds.has('f64')) return 'f64';
  return '';
}

function literalKind(node: Node): string | null {
  switch (node.type) {
    case 'integer': return 'i64';
    case 'float': return 'f64';
    case 'true':
    case 'false': return 'bool';
    case 'none': return 'null';
    case 'string':
    case 'concatenated_string': return stringValue(node) === null ? null : 'str';
    case 'unary_operator': {
      const operand = node.childForFieldName('argument');
      return operand ? literalKind(operand) : null;
    }
    default: return null;
  }
}

/** polars dtype classes, by the display name the readers use for them. */
const DTYPES: Record<string, string> = {
  Int8: 'i8', Int16: 'i16', Int32: 'i32', Int64: 'i64', Int128: 'i128',
  UInt8: 'u8', UInt16: 'u16', UInt32: 'u32', UInt64: 'u64',
  Float32: 'f32', Float64: 'f64', Boolean: 'bool',
  String: 'str', Utf8: 'str', Categorical: 'cat', Enum: 'enum',
  Binary: 'binary', Date: 'date', Time: 'time', Null: 'null', Object: 'object',
  Datetime: 'datetime[μs]', Duration: 'duration[μs]', Decimal: 'decimal'
};

/** `pl.Int64`, `Int64`, `pl.Datetime("ms")` — a dtype written in the source. */
function polarsDtype(node: Node): string {
  let target: Node | null = node;
  // A parametrised dtype is a call; its parameters change the display name in
  // ways not worth modelling, so only the bare ones keep their spelling.
  if (target.type === 'call') {
    const name = lastPart(dottedName(target.childForFieldName('function')));
    return name && DTYPES[name] && !/\[/.test(DTYPES[name]) ? DTYPES[name] : '';
  }
  const name = lastPart(dottedName(target));
  return name ? DTYPES[name] ?? '' : '';
}

function lastPart(name: string | null): string | null {
  return name ? name.slice(name.lastIndexOf('.') + 1) : null;
}

function pandasAliases(table: BindingTable): Set<string> {
  const out = new Set<string>();
  for (const imported of table.imports) {
    if (imported.module === 'pandas' && imported.name === null) out.add(imported.local);
  }
  return out;
}

function importsFrom(table: BindingTable, module: string, name: string): boolean {
  return table.imports.some((i) => i.module === module && i.name === name && i.local === name);
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
