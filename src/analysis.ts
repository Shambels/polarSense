import type { Parser, Tree } from 'web-tree-sitter';
import { parse, repairAtCursor } from './core/parser.js';
import { buildBindingTable, type BindingTable } from './core/bindings.js';

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

  constructor(private parser: Parser, private limit = 24) {}

  /**
   * Cached analysis of `source`, valid while `key` (uri + version) is unchanged.
   * The source is compared as well as the key: an editor is supposed to bump the
   * version on every edit, but a stale tree is a silently wrong completion, and
   * a string comparison is far cheaper than a reparse.
   */
  get(key: string, source: string): Analysis {
    const hit = this.cache.get(key);
    if (hit && hit.source === source) return hit.analysis;
    const analysis = this.analyze(source);
    this.cache.set(key, { source, analysis });
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return analysis;
  }

  /**
   * Analysis of the source with the cursor's line closed off. Only used when the
   * line really is unterminated — otherwise the cached parse is returned as-is.
   */
  atCursor(key: string, source: string, offset: number): Analysis {
    const repaired = repairAtCursor(source, offset);
    if (repaired === source) return this.get(key, source);
    return this.analyze(repaired);
  }

  analyze(source: string): Analysis {
    const tree = parse(this.parser, source);
    return { tree, table: buildBindingTable(tree) };
  }

  drop(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
