import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import { resolveAtOffset } from './core/resolve.js';
import { framesSources } from './core/frame.js';
import { evaluateFrame } from './core/schemaEval.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import type { PathContext } from './paths.js';
import { resolvePath } from './paths.js';
import { NO_MODULES, type ModuleService } from './modules.js';

/** A hover may wait longer than a completion — nothing is blocked on it. */
const BUDGET_MS = 1500;

/**
 * Hovering a column name shows its dtype and whatever the file's own metadata
 * says about it. For parquet that is null count, min and max, which sit in the
 * same footer already read for the schema — no extra I/O for the common case.
 */
export class ColumnHoverProvider implements vscode.HoverProvider {
  constructor(
    private analyzer: Analyzer,
    private schemas: SchemaService,
    private modules: ModuleService
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const settings = readSettings();
    if (!settings.enable) return undefined;

    const assembled = assemble(document, position);
    const modules = settings.followImports
      ? await this.modules.load(
          this.analyzer.tree(assembled.key, assembled.source),
          { documentDir: assembled.documentDir, workspaceDirs: workspaceDirs() }
        )
      : NO_MODULES;
    const analysis = this.analyzer.get(assembled.key, assembled.source, modules);
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

    // Inside a fragment — a SQL statement, a selector prefix — the range covers
    // the one identifier under the cursor rather than the whole string, so this
    // is the same lookup as anywhere else.
    const hovered = assembled.source.slice(resolution.contentStart, resolution.contentEnd);
    if (!hovered) return undefined;

    if (!resolution.source) {
      if (resolution.failure === 'not-in-string' || resolution.failure === 'not-a-column-site') {
        return undefined;
      }
      if (!settings.fallbackToAllSchemas || !resolution.allSources.length) return undefined;
      return this.unidentifiedFrameHover(resolution, hovered, ctx, range);
    }

    const sources = resolution.frame ? framesSources(resolution.frame) : [resolution.source];
    const results = await Promise.all(
      sources.map((source) => this.schemas.getWithBudget(source, ctx, BUDGET_MS))
    );
    if (token.isCancellationRequested) return undefined;
    const result = results[0];
    if (!result?.schema) return undefined;

    // Hover the columns that exist here, not everything the file holds.
    const byIndex = new Map(sources.map((source, i) => [source, results[i]?.schema?.columns]));
    const evaluated = resolution.frame
      ? evaluateFrame(resolution.frame, (s) => byIndex.get(s), analysis.table)
      : null;
    const columns = evaluated?.columns ?? result.schema.columns;

    const column = columns.find((c) => c.name === hovered);
    if (!column) return undefined;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${column.name}**${column.dtype ? ` · \`${column.dtype}\`` : ''}`);

    const stats = facts(column);
    if (stats.length) md.appendMarkdown(`\n\n${stats.join(' · ')}`);

    md.appendMarkdown(
      `\n\n_${displayPath(result.schema.origin, ctx)}` +
      `${result.schema.rowCount !== undefined ? ` · ${fmt(result.schema.rowCount)} rows` : ''}_`
    );
    return new vscode.Hover(md, range);
  }

  /**
   * The completion list falls back to every schema in the file when it cannot
   * identify the frame. Hover did not, so hovering a name the popup had just
   * offered produced nothing — the two disagreed about the same word.
   */
  private async unidentifiedFrameHover(
    resolution: ReturnType<typeof resolveAtOffset>,
    hovered: string,
    ctx: PathContext,
    range: vscode.Range
  ): Promise<vscode.Hover | undefined> {
    const results = await Promise.all(
      resolution.allSources.slice(0, 8).map((source) =>
        this.schemas.getWithBudget(source, ctx, BUDGET_MS).then((r) => ({ source, r }))
      )
    );
    for (const { r } of results) {
      const column = r?.schema?.columns.find((c) => c.name === hovered);
      if (!column || !r?.schema) continue;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${column.name}**${column.dtype ? ` · \`${column.dtype}\`` : ''}`);
      md.appendMarkdown(facts(column).length ? `\n\n${facts(column).join(' · ')}` : '');
      md.appendMarkdown(
        `\n\n_${displayPath(r.schema.origin, ctx)}` +
        `${r.schema.rowCount !== undefined ? ` · ${fmt(r.schema.rowCount)} rows` : ''}_`
      );
      md.appendMarkdown(
        '\n\n_The frame here could not be identified, so this is a column of the same' +
        ' name found elsewhere in the file._'
      );
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
}

/** Statistics worth printing, in a fixed order. */
function facts(column: { stats?: { min?: string; max?: string; nullCount?: number } }): string[] {
  const out: string[] = [];
  if (column.stats?.min !== undefined) out.push(`min \`${column.stats.min}\``);
  if (column.stats?.max !== undefined) out.push(`max \`${column.stats.max}\``);
  if (column.stats?.nullCount !== undefined) {
    out.push(column.stats.nullCount === 0 ? 'no nulls' : `${fmt(column.stats.nullCount)} nulls`);
  }
  return out;
}

/**
 * Workspace-relative where possible: two files both called part-0.parquet are
 * indistinguishable by basename, which is exactly when you most want to know
 * which one you are looking at.
 */
function displayPath(origin: string, ctx: PathContext): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(origin)) return origin;
  let best = path.basename(origin);
  for (const root of [...ctx.workspaceDirs, ctx.documentDir]) {
    const relative = path.relative(root, origin);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (relative.length < best.length || best === path.basename(origin)) best = relative;
  }
  return best;
}

function describeShape(columns: number, rows?: number): string {
  const cols = `${fmt(columns)} column${columns === 1 ? '' : 's'}`;
  return rows === undefined ? cols : `${cols} · ${fmt(rows)} rows`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
