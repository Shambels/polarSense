import * as vscode from 'vscode';
import * as path from 'node:path';

export interface AssembledDocument {
  /** Source to analyse: for a notebook cell, every code cell above it plus itself. */
  source: string;
  /** Cursor offset within `source`. */
  offset: number;
  /** Cache key — changes whenever any contributing cell changes. */
  key: string;
  /** Directory relative paths resolve against: the .py file's, or the .ipynb's. */
  documentDir: string;
  /** Offset of the current cell's start within `source`, to map ranges back. */
  cellOffset: number;
}

/**
 * A notebook cell arrives as its own TextDocument, which would scope every
 * binding to a single cell — useless, since `df` is defined once at the top.
 * So we hand the analyser every code cell above the cursor, in document order.
 *
 * Document order, not execution order: it is the order a reader assumes and the
 * order a re-run would use. Cells executed out of order will resolve as if they
 * had not been.
 */
export function assemble(document: vscode.TextDocument, position: vscode.Position): AssembledDocument {
  const offsetInCell = document.offsetAt(position);

  if (document.uri.scheme !== 'vscode-notebook-cell') {
    return {
      source: document.getText(),
      offset: offsetInCell,
      key: `${document.uri.toString()}:${document.version}`,
      documentDir: path.dirname(document.uri.fsPath),
      cellOffset: 0
    };
  }

  const notebook = vscode.workspace.notebookDocuments.find((nb) =>
    nb.getCells().some((cell) => cell.document.uri.toString() === document.uri.toString())
  );
  if (!notebook) {
    return {
      source: document.getText(),
      offset: offsetInCell,
      key: `${document.uri.toString()}:${document.version}`,
      documentDir: path.dirname(document.uri.fsPath),
      cellOffset: 0
    };
  }

  const parts: string[] = [];
  const versions: string[] = [];
  let cellOffset = 0;
  let found = false;

  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) continue;
    if (cell.document.languageId !== 'python') continue;
    const isCurrent = cell.document.uri.toString() === document.uri.toString();
    if (isCurrent) {
      cellOffset = parts.join('').length;
      parts.push(document.getText());
      versions.push(`${cell.index}@${document.version}`);
      found = true;
      break;
    }
    parts.push(cell.document.getText());
    versions.push(`${cell.index}@${cell.document.version}`);
  }

  if (!found) {
    cellOffset = parts.join('').length;
    parts.push(document.getText());
    versions.push(`self@${document.version}`);
  }

  // A newline between cells so the last line of one cell cannot fuse with the next.
  const source = parts.map((p) => (p.endsWith('\n') ? p : `${p}\n`)).join('');
  const padding = parts.slice(0, parts.length - 1)
    .reduce((sum, p) => sum + (p.endsWith('\n') ? 0 : 1), 0);

  return {
    source,
    offset: cellOffset + padding + offsetInCell,
    key: `${notebook.uri.toString()}:${versions.join(',')}`,
    documentDir: path.dirname(notebook.uri.fsPath),
    cellOffset: cellOffset + padding
  };
}
