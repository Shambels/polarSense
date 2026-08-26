import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { fmt, frameFacts, frameNotes } from './facts.js';

/**
 * The file behind the frame, a page at a time.
 *
 * The rule the whole panel is built around: **nothing crosses to the webview
 * that is not being drawn.** A page is a hundred rows of the columns on screen,
 * read out of the file when the page is asked for and forgotten afterwards — so
 * a four-million-row file costs what a four-hundred-row file costs, and the
 * message protocol never learns how to carry a dataset. That is the constraint
 * that is impossible to retrofit, so it is the one decided first.
 *
 * The host owns the state. The webview draws what it is sent and posts what was
 * clicked; every decision about what to read is made here, where it can be
 * tested without a browser.
 */

/** Rows in a page. Also the unit that is read: no page, no read. */
const PAGE = 100;

/** Columns drawn at once. A 200-column frame is navigated, not rendered. */
const COLUMN_WINDOW = 40;

interface View {
  frame: ResolvedFrame;
  /** Every column this panel can offer — the frame's, narrowed to what the file has. */
  columns: string[];
  /** Set once the file's own column list is known, so the offer can be corrected. */
  resolved: boolean;
  rowStart: number;
  columnStart: number;
  filter: string;
}

let panel: vscode.WebviewPanel | undefined;
let view: View | undefined;
let last: unknown;

export async function showData(api: PolarSenseApi): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    vscode.window.showInformationMessage('PolarSense: open a Python file to see a frame.');
    return;
  }

  const frame = await api.resolveFrameAt(editor.document.uri, editor.selection.active);
  if (!frame) {
    vscode.window.showInformationMessage(
      'PolarSense: no frame at the cursor. Put it on a DataFrame — the variable, ' +
      'or anywhere in the chain hanging off it.'
    );
    return;
  }

  view = {
    frame,
    columns: frame.columns.map((column) => column.name),
    resolved: false,
    rowStart: 0,
    columnStart: 0,
    filter: ''
  };
  last = undefined;

  const current = ensurePanel(api);
  current.title = path.basename(frame.uri) || 'PolarSense';
  // A fresh document each time the command runs: a new frame is a new table, and
  // the webview asks for its first page as soon as it has loaded.
  current.webview.html = shell(current.webview);
  current.reveal(vscode.ViewColumn.Beside, true);
}

function ensurePanel(api: PolarSenseApi): vscode.WebviewPanel {
  if (panel) return panel;
  panel = vscode.window.createWebviewPanel(
    'polarsense.data',
    'PolarSense',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    // Scripts, because paging without them means redrawing the document and
    // losing your place. Nothing is loaded from anywhere: no remote origin, no
    // local root, and every value arrives as data through postMessage rather
    // than as markup.
    { enableScripts: true, localResourceRoots: [] }
  );
  panel.onDidDispose(() => { panel = undefined; view = undefined; last = undefined; });
  panel.webview.onDidReceiveMessage((message) => onMessage(api, message));
  return panel;
}

/** What the webview can ask for: a page, a column window, a filter, or a redraw. */
interface Intent {
  type?: string;
  rowStart?: number;
  columnStart?: number;
  filter?: string;
}

async function onMessage(api: PolarSenseApi, message: Intent): Promise<void> {
  if (!panel || !view) return;

  // The webview is reloaded whenever it has been hidden, and it comes back with
  // no state at all — so it asks, rather than the host guessing when to tell it.
  if (message?.type === 'ready') {
    if (last) { void panel.webview.postMessage(last); return; }
    await update(api);
    return;
  }

  if (typeof message?.filter === 'string' && message.filter !== view.filter) {
    view.filter = message.filter;
    // A narrower list makes the old window meaningless.
    view.columnStart = 0;
  }
  if (typeof message?.rowStart === 'number') view.rowStart = Math.max(0, message.rowStart);
  if (typeof message?.columnStart === 'number') {
    view.columnStart = Math.max(0, message.columnStart);
  }
  await update(api);
}

/** Read the page the current view describes, and send exactly that. */
async function update(api: PolarSenseApi): Promise<void> {
  if (!panel || !view) return;
  const current = view;

  const matching = filtered(current);
  const drawn = matching.slice(current.columnStart, current.columnStart + COLUMN_WINDOW);

  let result = await api.readRows(current.frame, {
    columns: drawn,
    rowStart: current.rowStart,
    limit: PAGE
  });

  // First answer back also carries the file's own column list. A frame whose
  // columns were computed or renamed asks for names the file has never heard
  // of, and the honest correction is to offer what is actually there.
  const all = result.page?.allColumns ?? [];
  if (!current.resolved && all.length) {
    current.resolved = true;
    const known = new Set(all);
    const kept = current.columns.filter((name) => known.has(name));
    if (kept.length !== current.columns.length) {
      current.columns = kept.length ? kept : all;
      result = await api.readRows(current.frame, {
        columns: filtered(current).slice(current.columnStart, current.columnStart + COLUMN_WINDOW),
        rowStart: current.rowStart,
        limit: PAGE
      });
    }
  }

  last = payload(current, result.page, result.error);
  void panel.webview.postMessage(last);
}

function filtered(current: View): string[] {
  const needle = current.filter.trim().toLowerCase();
  if (!needle) return current.columns;
  return current.columns.filter((name) => name.toLowerCase().includes(needle));
}

interface Payload {
  file: string;
  uri: string;
  symbol?: string;
  facts: string[];
  notes: string[];
  columns: string[];
  dtypes: string[];
  rows: (string | null)[][];
  rowStart: number;
  rowCount?: number;
  more: boolean;
  pageSize: number;
  columnStart: number;
  columnCount: number;
  columnWindow: number;
  filter: string;
  hidden: number;
  error?: string;
}

function payload(
  current: View,
  page: { columns: string[]; dtypes: string[]; rows: (string | null)[][]; rowStart: number;
          rowCount?: number; more: boolean; prefixBytes?: number } | undefined,
  error: RowsFailure | undefined
): Payload {
  const notes = frameNotes(current.frame);
  if (page?.prefixBytes !== undefined) {
    notes.push(
      `This is a CSV: it has no footer to say where row ${fmt(page.rowStart + PAGE)} starts, ` +
      `so the rows here are the ones inside the first ${fmt(page.prefixBytes)} bytes of the ` +
      'file — a prefix, not the file. Reaching further means walking every row before it.'
    );
  }
  const hidden = current.frame.columns.length - current.columns.length;
  if (hidden > 0) {
    notes.push(
      `${fmt(hidden)} column${hidden === 1 ? '' : 's'} of this frame ${hidden === 1 ? 'is' : 'are'} ` +
      'computed or renamed and cannot be read from the file, so they are not offered here.'
    );
  }

  return {
    file: path.basename(current.frame.uri),
    uri: current.frame.uri,
    symbol: current.frame.symbol,
    facts: frameFacts(current.frame),
    notes,
    columns: page?.columns ?? [],
    dtypes: page?.dtypes ?? [],
    rows: page?.rows ?? [],
    rowStart: page?.rowStart ?? current.rowStart,
    rowCount: page?.rowCount,
    more: page?.more ?? false,
    pageSize: PAGE,
    columnStart: current.columnStart,
    columnCount: filtered(current).length,
    columnWindow: COLUMN_WINDOW,
    filter: current.filter,
    hidden: Math.max(0, hidden),
    error: error && explain(error, current.frame.kind)
  };
}

function explain(error: RowsFailure, kind: string): string {
  switch (error) {
    case 'unsupported-format':
      // Each of these is a page by another name — record batches, a list of
      // files — and each is work that has not been done. Saying which is which
      // beats an empty grid that reads as an empty file.
      return `Rows are read from parquet and CSV so far. This frame is ${kind}: ` +
        'its schema is known, its rows are not read yet.';
    case 'file-not-found': return 'The file behind this frame is not there any more.';
    case 'unsupported-scheme': return 'This location cannot be read from here.';
    default: return 'The rows could not be read. The log has the detail.';
  }
}

/**
 * The document, once. It holds no data: every value on screen arrives later as a
 * message and is written with `textContent`, which is what makes a column name
 * out of someone's parquet file unable to be anything but text.
 */
function shell(webview: vscode.Webview): string {
  const nonce = Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${
    webview.cspSource
  } 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>PolarSense</title>
<style>
  body{
    font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
    color:var(--vscode-foreground);background:var(--vscode-editor-background);
    padding:.8rem 1rem;margin:0;
  }
  h1{font-size:1.05rem;font-weight:600;margin:0 0 .15rem}
  .symbol{color:var(--vscode-descriptionForeground);font-weight:400}
  .origin{
    font-family:var(--vscode-editor-font-family);font-size:.8rem;
    color:var(--vscode-descriptionForeground);word-break:break-all;margin:0 0 .5rem;
  }
  .facts{
    display:flex;flex-wrap:wrap;gap:.35rem .55rem;list-style:none;padding:0;margin:0 0 .7rem;
    font-family:var(--vscode-editor-font-family);font-size:.78rem;
    color:var(--vscode-descriptionForeground);
  }
  .facts li{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:.05rem .4rem}
  .note{
    border-left:3px solid var(--vscode-textLink-foreground);
    background:var(--vscode-textBlockQuote-background);
    padding:.45rem .7rem;margin:0 0 .6rem;font-size:.85rem;
  }
  .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:0 0 .6rem}
  .bar .where{
    font-family:var(--vscode-editor-font-family);font-size:.78rem;
    color:var(--vscode-descriptionForeground);
  }
  button{
    font-family:inherit;font-size:.8rem;color:var(--vscode-button-secondaryForeground);
    background:var(--vscode-button-secondaryBackground);border:none;border-radius:2px;
    padding:.2rem .55rem;cursor:pointer;
  }
  button:hover:enabled{background:var(--vscode-button-secondaryHoverBackground)}
  button:disabled{opacity:.4;cursor:default}
  input{
    font-family:inherit;font-size:.8rem;color:var(--vscode-input-foreground);
    background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);
    border-radius:2px;padding:.2rem .4rem;min-width:9rem;
  }
  .scroller{overflow:auto;max-height:calc(100vh - 13rem);border:1px solid var(--vscode-panel-border)}
  table{border-collapse:separate;border-spacing:0;font-size:.82rem}
  th,td{
    text-align:left;padding:.22rem .6rem;white-space:nowrap;
    border-bottom:1px solid var(--vscode-panel-border);
  }
  thead th{
    position:sticky;top:0;z-index:2;background:var(--vscode-editor-background);
    font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;
    color:var(--vscode-descriptionForeground);
  }
  thead th .dtype{
    display:block;font-family:var(--vscode-editor-font-family);
    text-transform:none;letter-spacing:0;font-weight:400;opacity:.75;
  }
  td{font-family:var(--vscode-editor-font-family)}
  .index{
    position:sticky;left:0;z-index:1;background:var(--vscode-editor-background);
    color:var(--vscode-descriptionForeground);text-align:right;
    border-right:1px solid var(--vscode-panel-border);
  }
  thead .index{z-index:3}
  .null{opacity:.5;font-style:italic}
  .empty{padding:1rem 0;color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>
<h1 id="file"></h1>
<p class="origin" id="origin"></p>
<ul class="facts" id="facts"></ul>
<div id="notes"></div>
<div class="bar">
  <button id="prev">‹ rows</button>
  <button id="next">rows ›</button>
  <span class="where" id="where"></span>
  <button id="cprev">‹ columns</button>
  <button id="cnext">columns ›</button>
  <input id="filter" type="text" placeholder="filter columns" autocomplete="off">
  <span class="where" id="cwhere"></span>
</div>
<div class="scroller" id="scroller"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
<div class="empty" id="empty" hidden></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = null;
let timer = null;

window.addEventListener('message', (event) => { state = event.data; draw(); });

function send(patch) { vscode.postMessage(patch); }

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function draw() {
  if (!state) return;
  $('file').textContent = state.file;
  if (state.symbol) $('file').appendChild(text('span', ' · ' + state.symbol, 'symbol'));
  $('origin').textContent = state.uri;

  const facts = $('facts');
  facts.replaceChildren(...state.facts.map((fact) => text('li', fact)));

  const notes = state.error ? [state.error, ...state.notes] : state.notes;
  $('notes').replaceChildren(...notes.map((note) => text('p', note, 'note')));

  const last = state.rowStart + state.rows.length;
  $('where').textContent = state.rows.length
    ? 'rows ' + state.rowStart + '–' + (last - 1) +
      (state.rowCount === undefined ? '' : ' of ' + state.rowCount.toLocaleString('en-US'))
    : 'no rows';
  $('prev').disabled = state.rowStart <= 0;
  $('next').disabled = !state.more;

  const shown = state.columns.length;
  $('cwhere').textContent = shown
    ? 'columns ' + (state.columnStart + 1) + '–' + (state.columnStart + shown) +
      ' of ' + state.columnCount
    : 'no columns';
  $('cprev').disabled = state.columnStart <= 0;
  $('cnext').disabled = state.columnStart + shown >= state.columnCount;
  if ($('filter').value !== state.filter) $('filter').value = state.filter;

  const header = document.createElement('tr');
  header.appendChild(text('th', '#', 'index'));
  state.columns.forEach((name, i) => {
    const cell = text('th', name);
    if (state.dtypes[i]) cell.appendChild(text('span', state.dtypes[i], 'dtype'));
    header.appendChild(cell);
  });
  $('head').replaceChildren(header);

  const body = document.createDocumentFragment();
  state.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(text('td', String(state.rowStart + i), 'index'));
    row.forEach((value) => {
      tr.appendChild(value === null ? text('td', 'null', 'null') : text('td', value));
    });
    body.appendChild(tr);
  });
  $('body').replaceChildren(body);

  const nothing = !state.rows.length;
  $('scroller').hidden = nothing;
  $('empty').hidden = !nothing;
  $('empty').textContent = state.error ? '' : 'Nothing to show here.';
  $('scroller').scrollTop = 0;
}

$('prev').addEventListener('click', () =>
  send({ rowStart: Math.max(0, state.rowStart - state.pageSize) }));
$('next').addEventListener('click', () =>
  send({ rowStart: state.rowStart + state.pageSize }));
$('cprev').addEventListener('click', () =>
  send({ columnStart: Math.max(0, state.columnStart - state.columnWindow) }));
$('cnext').addEventListener('click', () =>
  send({ columnStart: state.columnStart + state.columnWindow }));
$('filter').addEventListener('input', (event) => {
  clearTimeout(timer);
  const value = event.target.value;
  // A keystroke is not a read: wait until the typing stops.
  timer = setTimeout(() => send({ filter: value }), 200);
});

send({ type: 'ready' });
</script>
</body>
</html>`;
}

/** Exported for the tests: the shell holds no data, so this is what to inspect. */
export function lastPayload(): unknown {
  return last;
}
