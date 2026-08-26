import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Column } from '../core/types.js';
import type { PolarSenseApi, ResolvedFrame } from '../api.js';
import { escape, fmt, frameFacts, frameNotes } from './facts.js';

/**
 * The hover, in a panel, with a row per column instead of a tooltip for one.
 *
 * Everything here is already in hand: dtype, null count, min and max come out of
 * the parquet footer the schema read paid for, and so do the row count, the row
 * groups and the codec. Nothing on this panel reads a row — which is why it can
 * open on a four-million-row file as fast as on a small one, and why there is no
 * setting guarding it the way `values.enable` guards value completion.
 *
 * What the footer cannot give is left off rather than guessed: no distinct
 * counts (a column read), no mean or quantiles (every value). Four exact
 * statistics beat eight where half are estimates.
 */
let panel: vscode.WebviewPanel | undefined;

export async function showDetails(api: PolarSenseApi): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    vscode.window.showInformationMessage('PolarSense: open a Python file to see a frame.');
    return;
  }

  const frame = await api.resolveFrameAt(editor.document.uri, editor.selection.active);
  if (!frame) {
    // The panel opens on a frame, so the cursor has to be on one. Saying which
    // is missing beats an empty panel that looks like a failed read.
    vscode.window.showInformationMessage(
      'PolarSense: no frame at the cursor. Put it on a DataFrame — the variable, ' +
      'or anywhere in the chain hanging off it.'
    );
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'polarsense.details',
      'PolarSense',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Nothing on this page needs to run, so nothing is allowed to. A column
      // name comes out of a data file, and a file is not something to trust.
      { enableScripts: false }
    );
    panel.onDidDispose(() => { panel = undefined; });
  }

  panel.title = path.basename(frame.uri) || 'PolarSense';
  panel.webview.html = renderDetails(frame);
  // Beside and without focus: this is something to glance at while typing, and
  // stealing the cursor would undo the position it was just read from.
  panel.reveal(vscode.ViewColumn.Beside, true);
}

/**
 * The whole page, as a string. Pure — no vscode, no I/O — so what it says about
 * a frame can be tested without an editor around it.
 */
export function renderDetails(frame: ResolvedFrame): string {
  const facts = frameFacts(frame);
  const notes = frameNotes(frame);

  const hasDtype = frame.columns.some((column) => column.dtype);
  const hasStats = frame.columns.some((column) => statOf(column).some((value) => value !== ''));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escape(path.basename(frame.uri))}</title>
<style>
  body{
    font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
    color:var(--vscode-foreground);background:var(--vscode-editor-background);
    padding:1rem 1.2rem;margin:0;
  }
  h1{font-size:1.05rem;font-weight:600;margin:0 0 .15rem}
  .symbol{color:var(--vscode-descriptionForeground);font-weight:400}
  .origin{
    font-family:var(--vscode-editor-font-family);font-size:.82rem;
    color:var(--vscode-descriptionForeground);word-break:break-all;margin:0 0 .5rem;
  }
  .facts{
    display:flex;flex-wrap:wrap;gap:.35rem .55rem;list-style:none;padding:0;margin:0 0 .9rem;
    font-family:var(--vscode-editor-font-family);font-size:.78rem;
    color:var(--vscode-descriptionForeground);
  }
  .facts li{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:.05rem .4rem}
  .note{
    border-left:3px solid var(--vscode-textLink-foreground);
    background:var(--vscode-textBlockQuote-background);
    padding:.5rem .7rem;margin:0 0 .8rem;font-size:.85rem;
  }
  .scroller{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{
    text-align:left;padding:.28rem .6rem .28rem 0;
    border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap;
  }
  th{
    font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
    color:var(--vscode-descriptionForeground);
  }
  td.name{font-family:var(--vscode-editor-font-family);white-space:normal;word-break:break-word}
  td.dtype{font-family:var(--vscode-editor-font-family);color:var(--vscode-symbolIcon-typeParameterForeground)}
  td.num{font-family:var(--vscode-editor-font-family);text-align:right;padding-right:1.1rem}
  td.value{font-family:var(--vscode-editor-font-family);max-width:22rem;overflow:hidden;text-overflow:ellipsis}
  .none{color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>
<h1>${escape(path.basename(frame.uri))}${
    frame.symbol ? ` <span class="symbol">· ${escape(frame.symbol)}</span>` : ''
  }</h1>
<p class="origin">${escape(frame.uri)}</p>
<ul class="facts">${facts.map((fact) => `<li>${escape(fact)}</li>`).join('')}</ul>
${notes.map((note) => `<p class="note">${note}</p>`).join('\n')}
<div class="scroller">
<table>
<thead><tr><th>Column</th>${hasDtype ? '<th>Type</th>' : ''}${
    hasStats ? '<th>Nulls</th><th>Min</th><th>Max</th>' : ''
  }</tr></thead>
<tbody>
${frame.columns.map((column) => row(column, hasDtype, hasStats)).join('\n')}
</tbody>
</table>
</div>
</body>
</html>`;
}

function row(column: Column, hasDtype: boolean, hasStats: boolean): string {
  const [nulls, min, max] = statOf(column);
  const cells = [`<td class="name">${escape(column.name)}</td>`];
  if (hasDtype) cells.push(`<td class="dtype">${escape(column.dtype)}</td>`);
  if (hasStats) {
    cells.push(`<td class="num">${cell(nulls)}</td>`);
    cells.push(`<td class="value">${cell(min)}</td>`);
    cells.push(`<td class="value">${cell(max)}</td>`);
  }
  return `<tr>${cells.join('')}</tr>`;
}

/**
 * Null count, min and max as they will be printed. A statistic the file did not
 * record is an empty string rather than a zero: "no nulls" and "the writer did
 * not say" are different answers, and only one of them is a fact.
 */
function statOf(column: Column): [string, string, string] {
  const stats = column.stats;
  return [
    stats?.nullCount === undefined ? '' : fmt(stats.nullCount),
    stats?.min ?? '',
    stats?.max ?? ''
  ];
}

function cell(value: string): string {
  return value === '' ? '<span class="none">—</span>' : escape(value);
}



