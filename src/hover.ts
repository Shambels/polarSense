import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import { resolveAtOffset } from './core/resolve.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import type { PathContext } from './paths.js';
import { resolvePath } from './paths.js';

/** A hover may wait longer than a completion — nothing is blocked on it. */
const BUDGET_MS = 1500;

/**
 * Hovering a column name shows its dtype and whatever the file's own metadata
 * says about it. For parquet that is null count, min and max, which sit in the
 * same footer already read for the schema — no extra I/O for the common case.
 */
export class ColumnHoverProvider implements vscode.HoverProvider {
  constructor(private analyzer: Analyzer, private schemas: SchemaService) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const settings = readSettings();
    if (!settings.enable) return undefined;

    const assembled = assemble(document, position);
    const analysis = this.analyzer.get(assembled.key, assembled.source);
    const resolution = resolveAtOffset(analysis.tree, analysis.table, assembled.offset);
    if (token.isCancellationRequested) return undefined;

    const ctx: PathContext = {
      documentDir: assembled.documentDir,
      workspaceDirs: workspaceDirs(),
      extraRoots: settings.pathRoots
    };
    const range = new vscode.Range(
      document.positionAt(Math.max(0, resolution.contentStart - assembled.cellOffset)),
      document.positionAt(Math.max(0, resolution.contentEnd - assembled.cellOffset))
    );

    // Hovering the path itself: say which file it actually resolves to.
    if (resolution.pathSite) {
      const site = analysis.table.sourceSites.find(
        (s) => s.start === resolution.contentStart && s.end === resolution.contentEnd
      );
      if (!site) return undefined;
      const resolved = await resolvePath(site.source, ctx);
      if (!resolved) return undefined;
      const result = await this.schemas.getWithBudget(site.source, ctx, BUDGET_MS);
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`\`${resolved.uri}\``);
      if (result?.schema) {
        md.appendMarkdown(`\n\n${describeShape(result.schema.columns.length, result.schema.rowCount)}`);
      }
      return new vscode.Hover(md, range);
    }

    if (!resolution.source) return undefined;

    const hovered = assembled.source.slice(resolution.contentStart, resolution.contentEnd);
    if (!hovered) return undefined;

    const result = await this.schemas.getWithBudget(resolution.source, ctx, BUDGET_MS);
    if (token.isCancellationRequested || !result?.schema) return undefined;

    const column = result.schema.columns.find((c) => c.name === hovered);
    if (!column) return undefined;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${column.name}**${column.dtype ? ` · \`${column.dtype}\`` : ''}`);

    const facts: string[] = [];
    if (column.stats?.min !== undefined) facts.push(`min \`${column.stats.min}\``);
    if (column.stats?.max !== undefined) facts.push(`max \`${column.stats.max}\``);
    if (column.stats?.nullCount !== undefined) {
      facts.push(column.stats.nullCount === 0 ? 'no nulls' : `${fmt(column.stats.nullCount)} nulls`);
    }
    if (facts.length) md.appendMarkdown(`\n\n${facts.join(' · ')}`);

    md.appendMarkdown(
      `\n\n_${path.basename(result.schema.origin)}` +
      `${result.schema.rowCount !== undefined ? ` · ${fmt(result.schema.rowCount)} rows` : ''}_`
    );
    return new vscode.Hover(md, range);
  }
}

function describeShape(columns: number, rows?: number): string {
  const cols = `${fmt(columns)} column${columns === 1 ? '' : 's'}`;
  return rows === undefined ? cols : `${cols} · ${fmt(rows)} rows`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
