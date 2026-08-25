import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Parser, Tree } from 'web-tree-sitter';
import { parse } from './core/parser.js';
import { readImports, type ModuleLoader } from './core/bindings.js';
import { ModuleGraph, moduleCandidates, type ModuleFile } from './core/modules.js';
import { trace } from './log.js';

/**
 * Reads the Python files the open document imports, so a frame built in
 * `loaders.py` is not invisible to the file that uses it.
 *
 * Demand-driven rather than a workspace index: only the modules actually
 * imported are read, following the chain a couple of hops, and the parse of each
 * is cached until its mtime changes. Nothing outside the workspace is opened —
 * an import that resolves into site-packages simply finds no file, which is the
 * right answer for `polars` and every other dependency.
 */

/** How far to follow imports, and how many files that may cost. */
const MAX_DEPTH = 2;
const MAX_MODULES = 16;
/** A source file bigger than this is not a module of hand-written loaders. */
const MAX_BYTES = 1_000_000;

export interface ModuleContext {
  documentDir: string;
  workspaceDirs: string[];
}

export interface ModuleSet {
  loader: ModuleLoader;
  /**
   * Identifies the exact set of module versions behind this loader, so a cached
   * binding table is not reused after one of them changes on disk.
   */
  fingerprint: string;
}

/** What a document with no resolvable imports gets — and what disables the feature. */
export const NO_MODULES: ModuleSet = { loader: { tableFor: () => null }, fingerprint: '' };

export class ModuleService {
  private cache = new Map<string, { stamp: string; tree: Tree }>();

  constructor(private parser: Parser, private limit = 64) {}

  /**
   * Every module reachable from `tree`, as a loader the binding table can query.
   * Resolution failures are silent: most imports are third-party and always will be.
   */
  async load(tree: Tree, ctx: ModuleContext): Promise<ModuleSet> {
    const files = new Map<string, ModuleFile>();
    const stamps: string[] = [];
    let frontier = [{ imports: readImports(tree), dir: ctx.documentDir }];

    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: typeof frontier = [];
      for (const { imports, dir } of frontier) {
        for (const imported of imports) {
          if (files.size >= MAX_MODULES) break;
          const found = await this.read(imported.module, dir, ctx.workspaceDirs, files);
          if (!found) continue;
          files.set(found.path, found);
          stamps.push(`${found.path}@${found.stamp}`);
          next.push({ imports: readImports(found.tree), dir: path.dirname(found.path) });
        }
      }
      frontier = next;
    }

    if (!files.size) return NO_MODULES;
    trace(`modules: ${files.size} for ${ctx.documentDir}`);
    const graph = new ModuleGraph(files, ctx.workspaceDirs);
    return { loader: graph.loaderFor(ctx.documentDir), fingerprint: stamps.sort().join(',') };
  }

  clear(): void {
    this.cache.clear();
  }

  /** The first candidate file that exists, parsed — reusing the parse if it is current. */
  private async read(
    module: string,
    fromDir: string,
    roots: string[],
    seen: Map<string, ModuleFile>
  ): Promise<(ModuleFile & { stamp: string }) | null> {
    for (const candidate of moduleCandidates(module, fromDir, roots)) {
      // Already read this round — following it again would only re-stat it.
      if (seen.has(candidate)) return null;
      const info = await fs.stat(candidate).catch(() => null);
      if (!info?.isFile() || info.size > MAX_BYTES) continue;

      const stamp = `${info.mtimeMs}:${info.size}`;
      const hit = this.cache.get(candidate);
      if (hit?.stamp === stamp) return { path: candidate, tree: hit.tree, stamp };

      const source = await fs.readFile(candidate, 'utf8').catch(() => null);
      if (source === null) continue;
      const tree = parse(this.parser, source);
      this.cache.set(candidate, { stamp, tree });
      while (this.cache.size > this.limit) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
      return { path: candidate, tree, stamp };
    }
    return null;
  }
}
