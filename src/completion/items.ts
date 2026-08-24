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
  entry.insertText = column.name;
  // Zero-padded so "10" sorts after "9", and prefixed so we sit above word-based
  // suggestions without fighting anything that has a real ranking.
  entry.sortText = `${ctx.uncertain ? '1' : '0'}${String(index).padStart(6, '0')}`;
  return entry;
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
