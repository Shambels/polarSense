import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import type { Column, SourceRef } from './core/types.js';
import { describeResolution, resolveAtOffset } from './core/resolve.js';
import { framesSources, type FrameExpr } from './core/frame.js';
import { evaluateFrame } from './core/schemaEval.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import { NO_MODULES, type ModuleService } from './modules.js';
import type { PathContext } from './paths.js';

/** A command may take its time: the user asked for it and is watching. */
const BUDGET_MS = 5000;

/**
 * The status bar says "24 cols". This is what happens when you click it.
 *
 * The columns themselves, with the statistics the schema read has already paid
 * for, and picking one writes it where the cursor is — replacing the string you
 * were in the middle of typing, if you were in one.
 */
export async function showSchema(
  analyzer: Analyzer,
  schemas: SchemaService,
  modules: ModuleService
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    vscode.window.showInformationMessage('PolarSense: open a Python file to see a schema.');
    return;
  }

  const settings = readSettings();
  const assembled = assemble(editor.document, editor.selection.active);
  const moduleSet = settings.followImports
    ? await modules.load(analyzer.tree(assembled.key, assembled.source), {
        documentDir: assembled.documentDir,
        workspaceDirs: workspaceDirs()
      })
    : NO_MODULES;
  const analysis = analyzer.get(assembled.key, assembled.source, moduleSet);
  const resolution = resolveAtOffset(analysis.tree, analysis.table, assembled.offset);
  const ctx: PathContext = {
    documentDir: assembled.documentDir,
    workspaceDirs: workspaceDirs(),
    extraRoots: settings.pathRoots
  };

  // The cursor's own frame, or — invoked from the palette with the cursor
  // anywhere — whichever source the file turns out to read.
  let source = resolution.source;
  let frame: FrameExpr | undefined = resolution.frame;
  if (!source) {
    const chosen = await chooseSource(resolution.allSources);
    if (!chosen) {
      const why = describeResolution(resolution) || 'no frame at the cursor';
      vscode.window.showInformationMessage(`PolarSense: ${why}.`);
      return;
    }
    source = chosen;
    frame = undefined;
  }

  const sources = frame ? framesSources(frame) : [source];
  const results = await Promise.all(
    sources.map((each) => schemas.getWithBudget(each, ctx, BUDGET_MS))
  );
  const primary = results[0];
  if (!primary?.schema) {
    vscode.window.showInformationMessage(
      `PolarSense: ${primary?.error ?? 'could not read the schema'}.`
    );
    return;
  }

  const byIndex = new Map(sources.map((each, i) => [each, results[i]?.schema?.columns]));
  const evaluated = frame
    ? evaluateFrame(frame, (each) => byIndex.get(each), analysis.table)
    : null;
  const columns = evaluated?.columns ?? primary.schema.columns;
  const approximate = !!evaluated && !evaluated.certain;

  const picked = await vscode.window.showQuickPick(columns.map(quickPickItem), {
    title: `${path.basename(primary.schema.origin)} · ${columns.length} columns` +
      (approximate ? ' (approximate)' : ''),
    placeHolder: 'Pick a column to insert it at the cursor',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return;

  await editor.edit((builder) => builder.replace(insertRange(editor, resolution, assembled), picked.label));
}

/**
 * Where the chosen name goes. Inside a column string or on a constraint keyword
 * the half-typed name is replaced; anywhere else it is inserted at the cursor.
 */
function insertRange(
  editor: vscode.TextEditor,
  resolution: ReturnType<typeof resolveAtOffset>,
  assembled: { cellOffset: number }
): vscode.Range | vscode.Selection {
  const replacing = resolution.source && !resolution.pathSite;
  if (!replacing) return editor.selection;
  const max = editor.document.getText().length;
  const start = Math.min(Math.max(0, resolution.contentStart - assembled.cellOffset), max);
  const end = Math.min(Math.max(start, resolution.contentEnd - assembled.cellOffset), max);
  return new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
}

/** The one source the file reads, or a pick between them. */
async function chooseSource(sources: SourceRef[]): Promise<SourceRef | undefined> {
  if (!sources.length) return undefined;
  if (sources.length === 1) return sources[0];
  const picked = await vscode.window.showQuickPick(
    sources.map((source) => ({
      label: source.symbol ?? path.basename(source.path ?? ''),
      description: source.path ?? undefined,
      detail: source.kind,
      source
    })),
    { title: 'Which frame?', placeHolder: 'The cursor is not in a frame this can identify' }
  );
  return picked?.source;
}

function quickPickItem(column: Column): vscode.QuickPickItem {
  const stats: string[] = [];
  if (column.stats?.min !== undefined) stats.push(`min ${column.stats.min}`);
  if (column.stats?.max !== undefined) stats.push(`max ${column.stats.max}`);
  if (column.stats?.nullCount !== undefined) {
    stats.push(column.stats.nullCount === 0 ? 'no nulls' : `${column.stats.nullCount} nulls`);
  }
  return {
    label: column.name,
    description: column.dtype || undefined,
    detail: stats.join(' · ') || undefined
  };
}
