import { Parser, Language, type Tree, type Node } from 'web-tree-sitter';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

let parserPromise: Promise<Parser> | null = null;

/**
 * Boot web-tree-sitter with the Python grammar. Both wasm files ship in assets/.
 * `assetDir` is the extension's install directory at runtime, and the repo root in tests.
 */
export function initParser(assetDir: string): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init({
        locateFile: (name: string) => path.join(assetDir, 'assets', name)
      });
      const wasm = await fs.readFile(path.join(assetDir, 'assets', 'tree-sitter-python.wasm'));
      const language = await Language.load(wasm);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((err) => {
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

export function parse(parser: Parser, source: string): Tree {
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter returned no tree');
  return tree;
}

/**
 * The cursor lives in half-written code. An unterminated string collapses the whole
 * statement into an ERROR node and we lose the call structure we need, so before
 * parsing we close any string and bracket the cursor's line left open.
 *
 * Returns the repaired source; the cursor offset is unchanged because every
 * character we add goes after it.
 */
export function repairAtCursor(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let lineEnd = source.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = source.length;
  const line = source.slice(lineStart, lineEnd);
  const col = offset - lineStart;

  // Scan the whole line to learn the bracket/quote state, but only repair if the
  // line is still open at its end (i.e. the editor has not auto-closed for us).
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') break;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  if (!quote && depth <= 0) return source;

  // Only repair when the cursor itself sits inside the unterminated string.
  if (quote) {
    const beforeCursor = line.slice(0, col);
    let q: string | null = null;
    for (let i = 0; i < beforeCursor.length; i++) {
      const ch = beforeCursor[i];
      if (q) {
        if (ch === '\\') { i++; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '#') break;
    }
    if (!q) return source;
  }

  const patch = (quote ?? '') + ')'.repeat(Math.max(0, depth));
  return source.slice(0, lineEnd) + patch + source.slice(lineEnd);
}

/** Deepest named node containing `offset`. */
export function nodeAt(tree: Tree, offset: number): Node | null {
  return tree.rootNode.namedDescendantForIndex(offset);
}

/** Walk up from `node` collecting ancestors, innermost first. */
export function ancestors(node: Node): Node[] {
  const out: Node[] = [];
  let cur: Node | null = node.parent;
  while (cur) {
    out.push(cur);
    cur = cur.parent;
  }
  return out;
}
