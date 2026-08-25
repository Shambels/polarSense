import * as vscode from 'vscode';
import type { Column, Schema } from '../core/types.js';
import * as path from 'node:path';

export interface ItemContext {
  /** Range covering the string's contents, so replacing never eats the quotes. */
  range: vscode.Range;
  /** Shown under the label; the file the columns came from. */
  origin: string;
  /** Set when the items come from the all-schemas fallback rather than one frame. */
  uncertain?: boolean;
  /** A constraint keyword position, where the name is followed by `=`. */
  keyword?: boolean;
}

/**
 * Columns list in *schema order*, not alphabetically — the order they appear in
 * the file is information, and VS Code sorts by `sortText` alone.
 */
export function buildItems(schema: Schema, ctx: ItemContext): vscode.CompletionItem[] {
  const origin = path.basename(ctx.origin);
  return schema.columns.map((column, index) => item(column, index, ctx, origin));
}

function item(
  column: Column,
  index: number,
  ctx: ItemContext,
  origin: string
): vscode.CompletionItem {
  const entry = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
  entry.detail = column.dtype || undefined;
  entry.documentation = new vscode.MarkdownString(
    ctx.uncertain
      ? `Column of \`${origin}\`\n\n_The frame at the cursor could not be identified, so this is every schema known in the file._`
      : `Column of \`${origin}\``
  );
  entry.range = ctx.range;
  entry.filterText = column.name;
  // `df.filter(region=…)`: the name alone is not usable there, and typing the
  // `=` is the next thing you would do anyway.
  entry.insertText = ctx.keyword ? `${column.name}=` : column.name;
  // Zero-padded so "10" sorts after "9", and prefixed so we sit above word-based
  // suggestions without fighting anything that has a real ranking.
  entry.sortText = `${ctx.uncertain ? '1' : '0'}${String(index).padStart(6, '0')}`;
  return entry;
}

/**
 * Data files and folders for a reader's path argument. Only the segment after the
 * last slash is replaced, so completing `data/sa` leaves `data/` alone — the same
 * way VS Code's own path completions behave.
 */
export function buildPathItems(
  candidates: { name: string; isDir: boolean; isTable?: boolean }[],
  range: vscode.Range
): vscode.CompletionItem[] {
  return candidates.map((candidate, index) => {
    const entry = new vscode.CompletionItem(
      candidate.name,
      candidate.isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
    );
    entry.range = range;
    entry.filterText = candidate.name;
    if (candidate.isDir && !candidate.isTable) {
      // Keep going: insert the separator and ask for the next level immediately.
      entry.insertText = `${candidate.name}/`;
      entry.command = { command: 'editor.action.triggerSuggest', title: 'continue path' };
    } else {
      entry.insertText = candidate.name;
    }
    if (candidate.isTable) entry.detail = 'table';
    // Folders first, then files, each group in directory order.
    entry.sortText = `${candidate.isDir ? '0' : '1'}${String(index).padStart(4, '0')}`;
    return entry;
  });
}

/** Merge several schemas for the fallback offer, keeping the first dtype seen. */
export function mergeSchemas(schemas: Schema[]): Schema {
  const columns: Column[] = [];
  const seen = new Set<string>();
  for (const schema of schemas) {
    for (const column of schema.columns) {
      if (seen.has(column.name)) continue;
      seen.add(column.name);
      columns.push(column);
    }
  }
  return { columns, origin: schemas.map((s) => path.basename(s.origin)).join(', ') };
}
