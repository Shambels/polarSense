import * as path from 'node:path';
import type { Tree } from 'web-tree-sitter';
import { buildBindingTable, type BindingTable, type ModuleLoader } from './bindings.js';

/**
 * Turning `from loaders import sales` into a binding table for `loaders.py`.
 *
 * The file reading lives in the I/O layer; everything here is path arithmetic
 * and memoisation, so the whole graph — including its cycle handling — is
 * testable against a map of source strings.
 */

export interface ModuleFile {
  /** Absolute path of the file, and the key it is stored under. */
  path: string;
  tree: Tree;
}

/** A `from`-import's dots, resolved against the importing file's directory. */
export function moduleCandidates(module: string, fromDir: string, roots: string[]): string[] {
  const dots = /^\.*/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots);
  const segments = rest ? rest.split('.') : [];

  // `.loaders` is this directory; `..pkg.loaders` is one above, and so on.
  const bases = dots > 0
    ? [path.resolve(fromDir, ...Array(dots - 1).fill('..'))]
    : [fromDir, ...roots];

  const out: string[] = [];
  for (const base of bases) {
    const stem = segments.length ? path.join(base, ...segments) : base;
    out.push(`${stem}.py`, path.join(stem, '__init__.py'));
  }
  return out;
}

/**
 * The binding tables of a set of already-parsed modules, built on demand.
 *
 * A module's own imports are followed the same way, so `main → loaders → sources`
 * works as long as every file in the chain was read. An import cycle resolves to
 * nothing on the edge that closes it rather than recursing forever.
 */
export class ModuleGraph {
  private tables = new Map<string, BindingTable>();
  private building = new Set<string>();

  constructor(private files: Map<string, ModuleFile>, private roots: string[]) {}

  /** A loader for a file living in `dir` — relative imports resolve from there. */
  loaderFor(dir: string): ModuleLoader {
    return { tableFor: (module) => this.tableFor(module, dir) };
  }

  private tableFor(module: string, dir: string): BindingTable | null {
    const key = moduleCandidates(module, dir, this.roots).find((c) => this.files.has(c));
    if (!key) return null;
    const built = this.tables.get(key);
    if (built) return built;
    // Mid-cycle: this module is still being built, so its table does not exist yet.
    if (this.building.has(key)) return null;

    const file = this.files.get(key)!;
    this.building.add(key);
    const table = buildBindingTable(file.tree, this.loaderFor(path.dirname(key)));
    this.building.delete(key);
    this.tables.set(key, table);
    return table;
  }
}
