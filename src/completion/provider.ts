import * as vscode from 'vscode';
import type { Analyzer } from '../analysis.js';
import type { SchemaService } from '../schema/index.js';
import type { Schema } from '../core/types.js';
import { resolveAtOffset, describeResolution } from '../core/resolve.js';
import { assemble } from '../notebook.js';
import { readSettings, workspaceDirs, type Settings } from '../config.js';
import { buildItems, buildPathItems, mergeSchemas } from './items.js';
import { trace } from '../log.js';
import { completeDataPaths, type PathContext } from '../paths.js';

/** How long a completion may wait for a cold read before answering "ask me again". */
const BUDGET_MS = 120;

export interface StatusReporter {
  report(text: string, tooltip?: string): void;
}

export class ColumnCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private analyzer: Analyzer,
    private schemas: SchemaService,
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
    const analysis = this.analyzer.atCursor(assembled.key, assembled.source, assembled.offset);
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
      const result = await this.schemas.getWithBudget(resolution.source, ctx, BUDGET_MS);
      if (token.isCancellationRequested) return undefined;

      if (!result) {
        // Read still running. Answer incomplete so VS Code asks again a keystroke later.
        this.status.report('$(sync~spin) reading schema…', resolution.source.path ?? '');
        return new vscode.CompletionList([], true);
      }
      if (result.schema) {
        this.status.report(
          `$(database) ${result.schema.columns.length} cols`,
          `${resolution.source.symbol ? `${resolution.source.symbol} → ` : ''}${result.uri}`
        );
        return new vscode.CompletionList(
          buildItems(result.schema, { range, origin: result.schema.origin }),
          false
        );
      }
      this.status.report(`$(warning) ${result.error ?? 'no schema'}`, resolution.source.path ?? '');
      return new vscode.CompletionList([], false);
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
