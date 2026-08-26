import type { Node } from 'web-tree-sitter';
import { callArguments } from './ast.js';
import type { SourceKind, SourceRef } from './types.js';

/**
 * A light scan of the SQL inside a string — enough to know which tables a
 * statement reads and whether a given offset is a column position. Deliberately
 * not a parser: it masks out literals and comments, then looks at what follows
 * `FROM` and `JOIN`.
 *
 * What that buys, and where it stops: every table in the statement is in scope
 * everywhere in it, so a subquery's tables leak outward and a join offers the
 * union of both sides. Completion can live with that — a name that exists
 * somewhere is offered, and marked uncertain once there is more than one table.
 * The unknown-column check cannot, so SQL positions are never typo-checked.
 */

/** Call names whose first argument is SQL rather than a path. */
export const SQL_FUNCS = new Set(['sql', 'query', 'execute', 'from_query']);

const READER_KINDS: Record<string, SourceKind> = {
  read_parquet: 'parquet',
  parquet_scan: 'parquet',
  read_csv: 'csv',
  read_csv_auto: 'csv',
  read_json: 'json',
  read_json_auto: 'json',
  read_ndjson: 'json',
  delta_scan: 'delta',
  iceberg_scan: 'iceberg'
};

const READER_CALL =
  /\b(read_parquet|parquet_scan|read_csv_auto|read_csv|read_json_auto|read_ndjson|read_json|delta_scan|iceberg_scan)\s*\(\s*(['"])([^'"]+)\2/i;
const QUOTED = /(['"])([^'"]+)\1/g;

const EXTENSIONS: [RegExp, SourceKind][] = [
  [/\.(parquet|pq)$/i, 'parquet'],
  [/\.(csv|tsv|txt)$/i, 'csv'],
  [/\.(arrow|ipc|feather)$/i, 'ipc'],
  [/\.(json|ndjson|jsonl)$/i, 'json'],
  [/\.(xlsx|xlsm)$/i, 'excel']
];

/**
 * A quoted literal becomes a run of this — not whitespace, so a table reference
 * scan stops at it rather than stepping over it looking for a name.
 */
const FILL = '\u0000';

/** How a masked character was masked. Escapes are only separators. */
const LITERAL = 1;
const COMMENT = 2;
const WORD_CHAR = /[A-Za-z_0-9$]/;
const WORD = /[A-Za-z_][A-Za-z_0-9$]*/g;

/**
 * Words that may follow a table reference. Anything else there is its alias, so
 * a gap in this list shows up as a phantom table rather than as silence.
 */
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON',
  'USING', 'UNION', 'EXCEPT', 'INTERSECT', 'QUALIFY', 'WINDOW', 'WITH', 'AS',
  'ANTI', 'SEMI', 'ASOF', 'LATERAL', 'POSITIONAL', 'TABLESAMPLE', 'VALUES',
  'SET', 'INTO', 'FETCH', 'DISTINCT', 'AND', 'OR', 'NOT'
]);

export interface SqlPath {
  kind: SourceKind;
  path: string;
  /** Offset of the path within the SQL, so an editor can link to it. */
  index: number;
}

/** The data file a SQL statement reads, when it names one plainly. */
export function dataPathInSql(sql: string): SqlPath | null {
  const reader = READER_CALL.exec(sql);
  if (reader) {
    const kind = READER_KINDS[reader[1].toLowerCase()];
    if (kind) {
      return { kind, path: reader[3], index: reader.index + reader[0].lastIndexOf(reader[3]) };
    }
  }
  for (const match of sql.matchAll(QUOTED)) {
    const value = match[2];
    const kind = EXTENSIONS.find(([pattern]) => pattern.test(value))?.[1];
    if (kind && match.index !== undefined) {
      return { kind, path: value, index: match.index + 1 };
    }
  }
  return null;
}

/** One table reference from a FROM or JOIN clause. */
export interface SqlTable {
  /** The reference as written — `self`, `sales`, `a.parquet`, `read_parquet(…)`. */
  name: string;
  alias: string | null;
  /** Set when the reference is a file rather than a name. */
  path: string | null;
  kind: SourceKind | null;
  /** Range of the reference and its alias within the SQL. */
  start: number;
  end: number;
}

/** Every table a statement reads, in the order they are written. */
export function sqlTables(sql: string): SqlTable[] {
  const { masked, marks } = maskLiterals(sql);
  const tables: SqlTable[] = [];
  WORD.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WORD.exec(masked))) {
    const keyword = match[0].toUpperCase();
    if (keyword !== 'FROM' && keyword !== 'JOIN') continue;

    let at = match.index + match[0].length;
    // A subquery leaves this where it was, so its own FROM is scanned in turn.
    let resume = at;
    for (;;) {
      const read = readTableRef(sql, masked, marks, at);
      if (!read) break;
      if (read.table) {
        tables.push(read.table);
        resume = read.next;
      }
      at = read.next;
      const comma = skipSpace(masked, at);
      if (masked[comma] !== ',') break;
      at = comma + 1;
    }
    WORD.lastIndex = Math.max(WORD.lastIndex, resume);
  }
  return tables;
}

export interface SqlPosition {
  /** Range of the identifier under the cursor, within the SQL. */
  wordStart: number;
  wordEnd: number;
  /** The qualifier in `s.regi|`, when there is one. */
  qualifier: string | null;
}

/**
 * The identifier at `offset`, when that offset is somewhere a column may appear.
 * Null inside a literal, a comment or a table reference — a name typed there is
 * a file or a table, and offering columns would be nonsense.
 */
export function sqlColumnPosition(
  sql: string, offset: number, tables: SqlTable[]
): SqlPosition | null {
  if (offset < 0 || offset > sql.length) return null;
  const { masked, marks } = maskLiterals(sql);
  if (marks[offset] || marks[offset - 1]) return null;
  if (tables.some((table) => offset >= table.start && offset <= table.end)) return null;

  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(masked[start - 1])) start--;
  while (end < masked.length && WORD_CHAR.test(masked[end])) end++;

  // `s.regi|` — the part before the dot says which table, and is not replaced.
  let qualifier: string | null = null;
  if (start > 0 && masked[start - 1] === '.') {
    let from = start - 1;
    while (from > 0 && WORD_CHAR.test(masked[from - 1])) from--;
    if (from < start - 1) qualifier = sql.slice(from, start - 1);
  }
  return { wordStart: start, wordEnd: end, qualifier };
}

/** Does this table reference answer to the name written before a dot? */
export function matchesQualifier(table: SqlTable, qualifier: string): boolean {
  const wanted = qualifier.toLowerCase();
  return table.alias?.toLowerCase() === wanted || table.name.toLowerCase() === wanted;
}

export interface SqlText {
  /** Raw contents of the string, exactly as they sit in the source. */
  text: string;
  /** Offset of those contents in the document. */
  base: number;
}

/**
 * The SQL a string node holds, measured in *source* offsets. Escape sequences
 * make a decoded value the wrong length, and every range here has to map back
 * onto the file being edited.
 */
export function sqlText(node: Node): SqlText | null {
  if (node.type !== 'string') return null;
  if (node.namedChildren.some((c) => c?.type === 'interpolation')) return null;
  const content = node.namedChildren.find((c) => c?.type === 'string_content');
  if (!content) return { text: '', base: node.startIndex + 1 };
  return { text: content.text, base: content.startIndex };
}

export interface SqlSource {
  source: SourceRef;
  /** Range of the path in the document. */
  start: number;
  end: number;
}

/** The source a `duckdb.sql(…)`-shaped call reads, if its SQL names a file. */
export function sqlSource(call: Node): SqlSource | null {
  const { positional, keywords } = callArguments(call);
  const arg = positional[0] ?? keywords.get('query') ?? keywords.get('sql');
  if (!arg) return null;
  const raw = sqlText(arg);
  if (!raw) return null;
  const found = dataPathInSql(raw.text);
  if (!found) return null;
  return {
    source: { kind: found.kind, path: found.path, kwargs: {} },
    start: raw.base + found.index,
    end: raw.base + found.index + found.path.length
  };
}

// --- the scan itself ---

/**
 * Quoted literals, comments and Python escape sequences, blanked to the same
 * length so every offset still maps onto the original text.
 */
function maskLiterals(sql: string): Masked {
  const out = sql.split('');
  const marks = new Uint8Array(sql.length);
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\\' && i + 1 < sql.length) {
      // Two source characters standing for one, and never part of an identifier.
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) {
        if (sql[j] === '\\') j++;
        j++;
      }
      for (let k = i; k <= Math.min(j, sql.length - 1); k++) {
        out[k] = FILL;
        marks[k] = LITERAL;
      }
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { marks[i] = COMMENT; out[i++] = ' '; }
    } else if (c === '/' && sql[i + 1] === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        marks[i] = COMMENT;
        out[i++] = ' ';
      }
      for (let k = i; k < Math.min(i + 2, sql.length); k++) { marks[k] = COMMENT; out[k] = ' '; }
      i += 2;
    } else {
      i++;
    }
  }
  return { masked: out.join(''), marks };
}

interface Masked {
  masked: string;
  /** LITERAL or COMMENT per character; 0 for everything a column may sit in. */
  marks: Uint8Array;
}

interface TableRead {
  table: SqlTable | null;
  next: number;
}

function readTableRef(
  sql: string, masked: string, marks: Uint8Array, from: number
): TableRead | null {
  const start = skipSpace(masked, from);
  if (start >= masked.length) return null;

  // A subquery. Its own tables are found by the top-level scan anyway.
  if (masked[start] === '(') {
    const close = matchParen(masked, start);
    return close === -1 ? null : { table: null, next: close + 1 };
  }

  let end: number;
  let path: string | null = null;
  let kind: SourceKind | null = null;

  if (marks[start] === LITERAL) {
    // `FROM 'data/sales.parquet'` — a file, quotes and all.
    end = start;
    while (end < masked.length && marks[end] === LITERAL) end++;
    path = sql.slice(start + 1, end - 1);
    kind = EXTENSIONS.find(([pattern]) => pattern.test(path as string))?.[1] ?? 'parquet';
  } else if (WORD_CHAR.test(masked[start])) {
    end = start;
    while (end < masked.length && (WORD_CHAR.test(masked[end]) || masked[end] === '.')) end++;
    const after = skipSpace(masked, end);
    if (masked[after] === '(') {
      // `FROM read_parquet('data/sales.parquet')`.
      const close = matchParen(masked, after);
      if (close === -1) return null;
      end = close + 1;
      const reader = READER_CALL.exec(sql.slice(start, end));
      if (reader) {
        path = reader[3];
        kind = READER_KINDS[reader[1].toLowerCase()] ?? null;
      }
    }
  } else {
    return null;
  }

  const name = path ?? sql.slice(start, end);
  let next = end;
  let alias: string | null = null;

  // `AS s`, or a bare word that is not the keyword beginning the next clause.
  const first = readWord(masked, next);
  if (first && first.text.toUpperCase() === 'AS') {
    const second = readWord(masked, first.end);
    if (second) {
      alias = sql.slice(second.start, second.end);
      next = second.end;
    }
  } else if (first && !KEYWORDS.has(first.text.toUpperCase())) {
    alias = sql.slice(first.start, first.end);
    next = first.end;
  }

  return { table: { name, alias, path, kind, start, end: next }, next };
}

function readWord(
  masked: string, from: number
): { text: string; start: number; end: number } | null {
  const start = skipSpace(masked, from);
  if (start >= masked.length || !/[A-Za-z_]/.test(masked[start])) return null;
  let end = start;
  while (end < masked.length && WORD_CHAR.test(masked[end])) end++;
  return { text: masked.slice(start, end), start, end };
}

function skipSpace(masked: string, from: number): number {
  let i = Math.max(0, from);
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return i;
  }
  return -1;
}
