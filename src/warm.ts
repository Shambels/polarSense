import * as vscode from 'vscode';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import { NO_MODULES, type ModuleService } from './modules.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import type { PathContext } from './paths.js';
import { trace } from './log.js';

/** Nothing is waiting on a warm read, so it may take as long as it needs. */
const BUDGET_MS = 10_000;

/** How many of a file's sources to read ahead of being asked. */
const MAX_SOURCES = 8;

/** Long enough for a burst of restored tabs to settle before any reading starts. */
const DELAY_MS = 250;

/**
 * Reads the schemas a file names before anyone asks for them.
 *
 * Every source in a document is known the moment it is parsed, so the read the
 * first completion would otherwise wait for can happen on open instead. That
 * read is the one visibly slow moment in the product: the list comes back empty
 * and `isIncomplete`, and you have to type another character before anything
 * appears.
 *
 * The unknown-column check already caused most of this as a side effect. What
 * this adds is that it happens with the check turned off, on open rather than a
 * pause after the first edit, and for every source the file names rather than
 * only the ones that sit at a column position.
 *
 * Re-warming is deliberately cheap rather than tracked: the parse is cached, and
 * a schema already read is a cache hit. So this can be called on every open and
 * every editor switch without bookkeeping to remember what it has done.
 */
export class SchemaWarmer {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private analyzer: Analyzer,
    private schemas: SchemaService,
    private modules: ModuleService
  ) {}

  schedule(document: vscode.TextDocument | undefined): void {
    if (!document || document.languageId !== 'python') return;
    const key = document.uri.toString();
    if (this.timers.has(key)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.warm(document);
    }, DELAY_MS));
  }

  private async warm(document: vscode.TextDocument): Promise<void> {
    const settings = readSettings();
    if (!settings.enable) return;

    const assembled = assemble(document, new vscode.Position(0, 0));
    const moduleSet = settings.followImports
      ? await this.modules.load(this.analyzer.tree(assembled.key, assembled.source), {
          documentDir: assembled.documentDir,
          workspaceDirs: workspaceDirs()
        })
      : NO_MODULES;

    // Built with the module loader, so a frame this file gets from loaders.py
    // is one of its sources too, and is warmed along with the rest.
    const analysis = this.analyzer.get(assembled.key, assembled.source, moduleSet);
    const known = analysis.table.allSources;
    const sources = known.slice(0, MAX_SOURCES);
    if (!sources.length) return;

    const ctx: PathContext = {
      documentDir: assembled.documentDir,
      workspaceDirs: workspaceDirs(),
      extraRoots: settings.pathRoots
    };
    const results = await Promise.all(
      sources.map((source) => this.schemas.getWithBudget(source, ctx, BUDGET_MS))
    );
    const read = results.filter((result) => result?.schema).length;
    // Says the real total, so a file past the cap does not look fully covered.
    trace(`warm: ${read} of ${known.length} schemas for ${document.uri.fsPath}`);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
