import * as vscode from 'vscode';
import type { Analyzer } from '../analysis.js';
import type { SchemaService } from '../schema/index.js';
import type { Schema } from '../core/types.js';
import { resolveAtOffset, describeResolution } from '../core/resolve.js';
import { framesSources } from '../core/frame.js';
import { evaluateFrame } from '../core/schemaEval.js';
import { assemble } from '../notebook.js';
import { readSettings, workspaceDirs, type Settings } from '../config.js';
import { buildItems, buildPathItems, mergeSchemas } from './items.js';
import { trace } from '../log.js';
import { completeDataPaths, type PathContext } from '../paths.js';
import { NO_MODULES, type ModuleService } from '../modules.js';

/** How long a completion may wait for a cold read before answering "ask me again". */
const BUDGET_MS = 120;

export interface StatusReporter {
  report(text: string, tooltip?: string): void;
}

export class ColumnCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private analyzer: Analyzer,
    private schemas: SchemaService,
    private modules: ModuleService,
    private status: StatusReporter
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    const settings = readSettings();
    if (!settings.enable) return undefined;

    const assembled = assemble(document, position);
    const modules = settings.followImports
      ? await this.modules.load(
          this.analyzer.tree(assembled.key, assembled.source),
          { documentDir: assembled.documentDir, workspaceDirs: workspaceDirs() }
        )
      : NO_MODULES;
    if (token.isCancellationRequested) return undefined;
    const analysis = this.analyzer.atCursor(
      assembled.key, assembled.source, assembled.offset, modules
    );
    const resolution = resolveAtOffset(analysis.tree, analysis.table, assembled.offset);

    if (resolution.failure === 'not-in-string' || resolution.failure === 'not-a-column-site') {
      return undefined;
    }
    if (token.isCancellationRequested) return undefined;

    const ctx: PathContext = {
      documentDir: assembled.documentDir,
      workspaceDirs: workspaceDirs(),
      extraRoots: settings.pathRoots
    };

    const range = this.contentRange(document, assembled, resolution.contentStart, resolution.contentEnd);

    if (resolution.pathSite) {
      const { prefix, kind } = resolution.pathSite;
      const candidates = await completeDataPaths(prefix, kind, ctx);
      if (token.isCancellationRequested || !candidates.length) return undefined;
      const segmentStart = resolution.contentStart + prefix.lastIndexOf('/') + 1;
      const segmentRange = this.contentRange(
        document, assembled, segmentStart, resolution.contentEnd
      );
      this.status.report(`$(folder) ${candidates.length} paths`);
      return new vscode.CompletionList(buildPathItems(candidates, segmentRange), true);
    }

    if (resolution.source) {
      trace(`resolve → ${describeResolution(resolution)}`);

      // Every source the frame reads from — two of them for a join.
      const sources = resolution.frame
        ? framesSources(resolution.frame)
        : [resolution.source];
      const results = await Promise.all(
        sources.map((source) => this.schemas.getWithBudget(source, ctx, BUDGET_MS))
      );
      if (token.isCancellationRequested) return undefined;

      if (results.some((r) => r === null)) {
        // A read is still running. Answer incomplete so VS Code asks again a
        // keystroke later, by which time the cache is warm.
        this.status.report('$(sync~spin) reading schema…', resolution.source.path ?? '');
        return new vscode.CompletionList([], true);
      }

      const primary = results[0];
      if (!primary?.schema) {
        this.status.report(
          `$(warning) ${primary?.error ?? 'no schema'}`, resolution.source.path ?? ''
        );
        return new vscode.CompletionList([], false);
      }

      const byIndex = new Map(sources.map((source, i) => [source, results[i]?.schema?.columns]));
      const evaluated = resolution.frame
        ? evaluateFrame(resolution.frame, (s) => byIndex.get(s), analysis.table)
        : { columns: primary.schema.columns, certain: true };

      const columns = evaluated?.columns ?? primary.schema.columns;
      const certain = evaluated?.certain ?? false;
      this.status.report(
        `$(database) ${columns.length} cols${certain ? '' : ' (approx)'}`,
        `${resolution.source.symbol ? `${resolution.source.symbol} → ` : ''}${results[0]?.uri ?? ''}`
      );
      return new vscode.CompletionList(
        buildItems(
          { columns, rowCount: primary.schema.rowCount, origin: primary.schema.origin },
          { range, origin: primary.schema.origin, uncertain: !certain }
        ),
        false
      );
    }

    // No identifiable frame. Offer the union of what the file knows, if allowed.
    this.status.report(`$(circle-slash) ${describeResolution(resolution)}`);
    if (!settings.fallbackToAllSchemas || !resolution.allSources.length) return undefined;

    const schemas = await this.collectAll(resolution.allSources, ctx, settings);
    if (token.isCancellationRequested || !schemas.length) return undefined;

    const merged = mergeSchemas(schemas);
    return new vscode.CompletionList(
      buildItems(merged, { range, origin: merged.origin, uncertain: true }),
      false
    );
  }

  private async collectAll(
    sources: ReturnType<typeof resolveAtOffset>['allSources'],
    ctx: PathContext,
    settings: Settings
  ): Promise<Schema[]> {
    void settings;
    const results = await Promise.all(
      sources.slice(0, 8).map((source) => this.schemas.getWithBudget(source, ctx, BUDGET_MS))
    );
    return results
      .map((r) => r?.schema)
      .filter((s): s is Schema => !!s);
  }

  /** Map offsets in the assembled source back to a range in the real document. */
  private contentRange(
    document: vscode.TextDocument,
    assembled: { cellOffset: number },
    start: number,
    end: number
  ): vscode.Range {
    const localStart = Math.max(0, start - assembled.cellOffset);
    const localEnd = Math.max(localStart, end - assembled.cellOffset);
    const max = document.getText().length;
    return new vscode.Range(
      document.positionAt(Math.min(localStart, max)),
      document.positionAt(Math.min(localEnd, max))
    );
  }
}
