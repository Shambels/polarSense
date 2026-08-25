import type { Parser, Tree } from 'web-tree-sitter';
import { parse, repairAtCursor } from './core/parser.js';
import { buildBindingTable, type BindingTable } from './core/bindings.js';
import type { ModuleSet } from './modules.js';

export interface Analysis {
  tree: Tree;
  table: BindingTable;
}

/**
 * Parses and builds the binding table, keeping one result per document version.
 * A keystroke inside an already-parsed document costs a cache lookup.
 */
export class Analyzer {
  private cache = new Map<string, { source: string; analysis: Analysis }>();
  private trees = new Map<string, { source: string; tree: Tree }>();

  constructor(private parser: Parser, private limit = 24) {}

  /**
   * The parse alone. The module loader needs a document's imports before the
   * table that will use it can be built, and re-parsing for that would double
   * the cost of every keystroke.
   */
  tree(key: string, source: string): Tree {
    const hit = this.trees.get(key);
    if (hit && hit.source === source) return hit.tree;
    const tree = parse(this.parser, source);
    this.trees.set(key, { source, tree });
    evict(this.trees, this.limit);
    return tree;
  }

  /**
   * Cached analysis of `source`, valid while `key` (uri + version) is unchanged.
   * The source is compared as well as the key: an editor is supposed to bump the
   * version on every edit, but a stale tree is a silently wrong completion, and
   * a string comparison is far cheaper than a reparse.
   */
  get(key: string, source: string, modules?: ModuleSet): Analysis {
    const cacheKey = modules?.fingerprint ? `${key}|${modules.fingerprint}` : key;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.source === source) return hit.analysis;
    const tree = this.tree(key, source);
    const analysis: Analysis = { tree, table: buildBindingTable(tree, modules?.loader) };
    this.cache.set(cacheKey, { source, analysis });
    evict(this.cache, this.limit);
    return analysis;
  }

  /**
   * Analysis of the source with the cursor's line closed off. Only used when the
   * line really is unterminated — otherwise the cached parse is returned as-is.
   */
  atCursor(key: string, source: string, offset: number, modules?: ModuleSet): Analysis {
    const repaired = repairAtCursor(source, offset);
    if (repaired === source) return this.get(key, source, modules);
    const tree = parse(this.parser, repaired);
    return { tree, table: buildBindingTable(tree, modules?.loader) };
  }

  drop(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    for (const key of [...this.trees.keys()]) {
      if (key.startsWith(prefix)) this.trees.delete(key);
    }
  }
}

function evict(cache: Map<string, unknown>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
