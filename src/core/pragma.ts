import type { Node, Tree } from 'web-tree-sitter';
import type { SourceKind, SourceRef } from './types.js';

/**
 * The escape hatch. Everything else in this extension reads the code; this reads
 * a comment the developer wrote, and it exists for the frames static reading
 * cannot follow — a path arriving as a function parameter, a config attribute, an
 * environment variable.
 *
 *     # polarsense: data/sales.parquet
 *     return pl.scan_parquet(cfg.source_path)
 *
 *     def report(df):  # polarsense: data/sales.parquet
 *
 * It is consulted last, never first: a path the resolver can work out for itself
 * always wins, so a pragma left behind after the code was fixed cannot start
 * lying about a frame that is now readable.
 */

const PRAGMA = /^#\s*polarsense:\s*(.+?)\s*$/;
const KINDS: SourceKind[] = ['parquet', 'csv', 'ipc', 'delta', 'iceberg', 'json', 'excel'];

/** Delta and Iceberg tables are directories, so their kind has to be said aloud. */
const KIND_PREFIX = new RegExp(`^(${KINDS.join('|')})\\s+(.+)$`, 'i');

const EXTENSIONS: [RegExp, SourceKind][] = [
  [/\.(parquet|pq)$/i, 'parquet'],
  [/\.(csv|tsv|txt)$/i, 'csv'],
  [/\.(arrow|ipc|feather)$/i, 'ipc'],
  [/\.(json|ndjson|jsonl)$/i, 'json'],
  [/\.(xlsx|xlsm)$/i, 'excel']
];

export interface Pragma {
  source: SourceRef;
  /** Byte range of the path inside the comment, so it can be a document link. */
  start: number;
  end: number;
  /**
   * True when the comment is alone on its line. That is the difference between
   * a pragma introducing the statement *below* it and one trailing the statement
   * it sits on — without which `x = 1  # polarsense: …` would also claim the
   * next line.
   */
  standalone: boolean;
}

/** Every pragma in the file, by the row its comment sits on. */
export function collectPragmas(tree: Tree): Map<number, Pragma> {
  const found = new Map<number, Pragma>();
  const source = tree.rootNode.text;
  for (const comment of tree.rootNode.descendantsOfType('comment')) {
    if (!comment) continue;
    const match = PRAGMA.exec(comment.text.trim());
    if (!match) continue;
    const parsed = parseTarget(match[1]);
    if (!parsed) continue;
    // Offsets are measured from the comment's own text, so a trailing pragma
    // links the same way as one on its own line.
    const offset = comment.text.indexOf(parsed.written);
    const start = comment.startIndex + (offset === -1 ? 0 : offset);
    const lineStart = source.lastIndexOf('\n', comment.startIndex - 1) + 1;
    found.set(comment.startPosition.row, {
      source: { kind: parsed.kind, path: parsed.path, kwargs: {} },
      start,
      end: start + parsed.written.length,
      standalone: source.slice(lineStart, comment.startIndex).trim() === ''
    });
  }
  return found;
}

interface Target {
  kind: SourceKind;
  path: string;
  /** The path exactly as written, quotes included, for the link range. */
  written: string;
}

function parseTarget(value: string): Target | null {
  let rest = value;
  let kind: SourceKind | null = null;

  const prefixed = KIND_PREFIX.exec(rest);
  if (prefixed) {
    kind = prefixed[1].toLowerCase() as SourceKind;
    rest = prefixed[2].trim();
  }
  if (!rest) return null;

  const written = rest;
  const quoted = /^(['"])(.*)\1$/.exec(rest);
  const path = quoted ? quoted[2] : rest;
  if (!path) return null;

  // Without an explicit kind, the extension decides — and a bare directory of
  // parquet is the common enough case to be the default.
  const inferred = EXTENSIONS.find(([pattern]) => pattern.test(path))?.[1];
  return { kind: kind ?? inferred ?? 'parquet', path, written };
}

/**
 * The pragma governing a node: one attached to the statement it belongs to,
 * whether trailing anywhere within it or sitting on the line above.
 */
export function pragmaFor(node: Node, pragmas: Map<number, Pragma>): SourceRef | null {
  if (!pragmas.size) return null;
  const statement = enclosingStatement(node);
  return inRows(pragmas, statement.startPosition.row, statement.endPosition.row);
}

/**
 * The pragma governing a name bound as a function parameter — written on the
 * `def` line, where the parameter with no path is visible.
 */
export function parameterPragma(node: Node, pragmas: Map<number, Pragma>): SourceRef | null {
  if (!pragmas.size || node.type !== 'identifier') return null;
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_definition' && hasParameter(cur, node.text)) {
      // The header only. A pragma inside the body belongs to its own statement.
      const header = cur.childForFieldName('parameters') ?? cur;
      return inRows(pragmas, cur.startPosition.row, header.endPosition.row);
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * A pragma for the rows `from`..`to`. The line above only counts when the comment
 * is alone on it — a pragma trailing some other statement belongs to that one.
 */
function inRows(pragmas: Map<number, Pragma>, from: number, to: number): SourceRef | null {
  const above = pragmas.get(from - 1);
  if (above?.standalone) return above.source;
  for (let row = from; row <= to; row++) {
    const found = pragmas.get(row);
    if (found) return found.source;
  }
  return null;
}

/** The simple statement a node belongs to, or the whole file if it has none. */
function enclosingStatement(node: Node): Node {
  let cur: Node = node;
  while (cur.parent && cur.parent.type !== 'block' && cur.parent.type !== 'module') {
    cur = cur.parent;
  }
  return cur;
}

function hasParameter(fn: Node, name: string): boolean {
  const list = fn.childForFieldName('parameters');
  if (!list) return false;
  for (const param of list.namedChildren) {
    if (!param) continue;
    if (param.type === 'identifier') {
      if (param.text === name) return true;
      continue;
    }
    const id = param.namedChildren.find((c) => c?.type === 'identifier');
    if (id?.text === name) return true;
  }
  return false;
}
