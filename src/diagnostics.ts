import * as vscode from 'vscode';
import type { Node } from 'web-tree-sitter';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import type { Column } from './core/types.js';
import type { ExprContext } from './core/exprNames.js';
import { resolveAtOffset } from './core/resolve.js';
import { framesSources } from './core/frame.js';
import { evaluateFrame } from './core/schemaEval.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import type { PathContext } from './paths.js';
import { trace } from './log.js';
import { nearest } from './core/nearest.js';
import { NO_MODULES, type ModuleService } from './modules.js';

const SOURCE = 'polarsense';
const CODE = 'unknown-column';

/** Diagnostics may take their time; nothing is waiting on them. */
const BUDGET_MS = 3000;

/** How long to wait after a keystroke before re-checking a document. */
const DEBOUNCE_MS = 400;

/**
 * Warns about column names that do not exist in the frame's schema — a typo
 * caught while typing rather than ten minutes into a scan.
 *
 * The whole design is about when to say *nothing*. A diagnostic that cries wolf
 * gets switched off and never switched back on, so this only speaks when the
 * schema evaluator reports `certain`: the frame was identified, its file was
 * read, and every transform between the two was one we model. An unmodelled
 * reshape, a selector it cannot narrow, an unresolved frame or a truncated
 * schema all mean silence, not a guess.
 */
export class ColumnDiagnostics {
  private collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private timers = new Map<string, NodeJS.Timeout>();
  /** Suggestions per diagnostic position, for the quick fix. */
  private fixes = new Map<string, string[]>();

  constructor(
    private analyzer: Analyzer,
    private schemas: SchemaService,
    private modules: ModuleService
  ) {}

  /** Re-check after a pause, so typing does not trigger a read per keystroke. */
  schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.refresh(document);
    }, DEBOUNCE_MS));
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'python') return;
    const settings = readSettings();
    if (!settings.enable || !settings.diagnosticsEnabled) {
      this.collection.delete(document.uri);
      return;
    }

    const key = document.uri.toString();
    for (const k of [...this.fixes.keys()]) {
      if (k.startsWith(`${key}#`)) this.fixes.delete(k);
    }

    const assembled = assemble(document, new vscode.Position(0, 0));
    const modules = settings.followImports
      ? await this.modules.load(
          this.analyzer.tree(assembled.key, assembled.source),
          { documentDir: assembled.documentDir, workspaceDirs: workspaceDirs() }
        )
      : NO_MODULES;
    const analysis = this.analyzer.get(assembled.key, assembled.source, modules);
    const ctx: PathContext = {
      documentDir: assembled.documentDir,
      workspaceDirs: workspaceDirs(),
      extraRoots: settings.pathRoots
    };

    const diagnostics: vscode.Diagnostic[] = [];
    const strings = analysis.tree.rootNode.descendantsOfType('string') as Node[];

    for (const node of strings) {
      // Only this cell's own strings, for notebooks.
      if (node.startIndex < assembled.cellOffset) continue;

      const resolution = resolveAtOffset(analysis.tree, analysis.table, node.startIndex + 1);
      if (!resolution.source || resolution.contentEnd <= resolution.contentStart) continue;
      // `cs.starts_with("reg")` holds a fragment, not a name that must exist.
      if (resolution.partial) continue;

      const name = assembled.source.slice(resolution.contentStart, resolution.contentEnd);
      if (!name) continue;

      const columns = await this.columnsFor(resolution, ctx, settings.maxColumns, analysis.table);
      if (!columns) continue; // uncertain, unreadable, or truncated — stay quiet

      if (columns.some((c) => c.name === name)) continue;

      const start = document.positionAt(resolution.contentStart - assembled.cellOffset);
      const end = document.positionAt(resolution.contentEnd - assembled.cellOffset);
      const range = new vscode.Range(start, end);

      const suggestions = nearest(name, columns.map((c) => c.name));
      const hint = suggestions.length ? ` Did you mean ${quoteList(suggestions)}?` : '';
      const diagnostic = new vscode.Diagnostic(
        range,
        `No column "${name}" in this frame.${hint}`,
        // A warning, not an error: the schema on disk may be older than the code
        // that will run, and polars — not this extension — has the last word.
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = SOURCE;
      diagnostic.code = CODE;
      diagnostics.push(diagnostic);
      if (suggestions.length) {
        this.fixes.set(positionKey(document.uri, range), suggestions);
      }
    }

    trace(`diagnostics: ${diagnostics.length} in ${document.uri.fsPath}`);
    this.collection.set(document.uri, diagnostics);
  }

  /**
   * The columns that exist at this position, or null when we are not sure enough
   * to accuse anyone of a typo.
   */
  private async columnsFor(
    resolution: ReturnType<typeof resolveAtOffset>,
    ctx: PathContext,
    maxColumns: number,
    exprCtx: ExprContext
  ): Promise<Column[] | null> {
    if (!resolution.source) return null;
    const sources = resolution.frame ? framesSources(resolution.frame) : [resolution.source];
    const results = await Promise.all(
      sources.map((source) => this.schemas.getWithBudget(source, ctx, BUDGET_MS))
    );
    if (results.some((r) => !r?.schema)) return null;

    const byIndex = new Map(sources.map((source, i) => [source, results[i]?.schema?.columns]));
    const evaluated = resolution.frame
      ? evaluateFrame(resolution.frame, (s) => byIndex.get(s), exprCtx)
      : null;

    // Without a frame expression we only know the raw file, which after any
    // transform is not what exists here.
    if (!evaluated || !evaluated.certain) return null;

    // A schema clipped by maxColumns cannot answer "does this column exist".
    if (evaluated.columns.length >= maxColumns) return null;

    return evaluated.columns;
  }

  suggestionsAt(uri: vscode.Uri, range: vscode.Range): string[] {
    return this.fixes.get(positionKey(uri, range)) ?? [];
  }

  clear(document: vscode.TextDocument): void {
    clearTimeout(this.timers.get(document.uri.toString()));
    this.timers.delete(document.uri.toString());
    this.collection.delete(document.uri);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.collection.dispose();
  }
}

/** Offers the closest column name as a one-click replacement. */
export class ColumnQuickFix implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(readonly diagnostics: ColumnDiagnostics) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SOURCE || diagnostic.code !== CODE) continue;
      for (const suggestion of this.diagnostics.suggestionsAt(document.uri, diagnostic.range)) {
        const action = new vscode.CodeAction(
          `Change to "${suggestion}"`,
          vscode.CodeActionKind.QuickFix
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, suggestion);
        action.diagnostics = [diagnostic];
        action.isPreferred = actions.length === 0;
        actions.push(action);
      }
    }
    void range;
    return actions;
  }
}

function positionKey(uri: vscode.Uri, range: vscode.Range): string {
  return `${uri.toString()}#${range.start.line}:${range.start.character}`;
}

function quoteList(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}
