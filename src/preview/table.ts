import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { dtypeClass, fmt, frameFacts, frameNotes, PANEL_CSS } from './facts.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';

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

export async function showData(api: PolarSenseApi, at?: FrameTarget): Promise<void> {
  const target = at ?? cursorTarget();
  if (!target) {
    vscode.window.showInformationMessage(NO_PYTHON);
    return;
  }

  const frame = await api.resolveFrameAt(target.uri, target.position);
  if (!frame) {
    vscode.window.showInformationMessage(target.missing);
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
  /** The dtype family per column, for colour. Computed here so the page has no rule of its own. */
  kinds: string[];
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
    kinds: (page?.dtypes ?? []).map(dtypeClass),
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
<style>${PANEL_CSS}
  .head{padding:.85rem 1.05rem .6rem}
  .bar{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;margin:.7rem 0 .1rem}
  .group{
    display:inline-flex;align-items:center;
    border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
    border-radius:5px;overflow:hidden;background:var(--vscode-editorWidget-background);
  }
  .group .where{
    padding:0 .55rem;font-size:.74rem;font-variant-numeric:tabular-nums;
    color:var(--vscode-descriptionForeground);white-space:nowrap;
  }
  button{
    font-family:inherit;font-size:.82rem;line-height:1;
    color:var(--vscode-foreground);background:transparent;border:none;
    padding:.3rem .5rem;cursor:pointer;
  }
  button:hover:enabled{background:var(--vscode-toolbar-hoverBackground)}
  button:active:enabled{background:var(--vscode-toolbar-activeBackground)}
  button:disabled{opacity:.35;cursor:default}
  button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  input{
    font-family:inherit;font-size:.78rem;color:var(--vscode-input-foreground);
    background:var(--vscode-input-background);
    border:1px solid var(--vscode-widget-border,transparent);
    border-radius:5px;padding:.28rem .55rem;min-width:9.5rem;
  }
  input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  input::placeholder{color:var(--vscode-input-placeholderForeground)}
  thead th .dtype{
    display:block;margin-top:.15rem;font-family:var(--vscode-editor-font-family);
    text-transform:none;letter-spacing:0;font-weight:400;opacity:.7;
  }
  thead th.num{text-align:right}
  tbody td{font-family:var(--vscode-editor-font-family)}
  .index{
    position:sticky;left:0;z-index:1;
    background:var(--vscode-editorWidget-background,var(--vscode-editor-background));
    color:var(--vscode-descriptionForeground);text-align:right;
    font-variant-numeric:tabular-nums;
    box-shadow:inset -1px 0 var(--vscode-panel-border);
  }
  thead .index{z-index:3}
  /* A wash of the column's own dtype colour — enough to see where a column
     begins and ends across forty of them, far too little to read as data.
     A null gets none of it, which is what makes an empty cell obvious. */
  #body td.t-str{background:color-mix(in srgb,var(--vscode-charts-blue) 7%,transparent)}
  #body td.t-int{background:color-mix(in srgb,var(--vscode-charts-green) 7%,transparent)}
  #body td.t-float{background:color-mix(in srgb,var(--vscode-charts-purple) 7%,transparent)}
  #body td.t-bool{background:color-mix(in srgb,var(--vscode-charts-orange) 7%,transparent)}
  #body td.t-temporal{background:color-mix(in srgb,var(--vscode-charts-yellow) 7%,transparent)}
  #body td.t-nested{background:color-mix(in srgb,var(--vscode-charts-red) 5%,transparent)}
  tbody tr:hover td,tbody tr:hover .index{background:var(--vscode-list-hoverBackground)}
  /* The pager, again, at the edge you actually ran out of data at. */
  .grid{position:relative;flex:1;min-height:0;display:flex;border-top:1px solid var(--vscode-panel-border)}
  .edge{
    position:absolute;z-index:4;width:1.7rem;height:1.7rem;padding:0;
    display:flex;align-items:center;justify-content:center;
    font-size:.85rem;border-radius:50%;
    /* Opaque: a translucent disc with a digit showing through it reads as a
       smudge rather than as a control. */
    background:var(--vscode-editorWidget-background);
    border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
    box-shadow:0 1px 4px rgba(0,0,0,.22);
  }
  .edge:hover{background:var(--vscode-toolbar-hoverBackground)}
  .edge[hidden]{display:none}
  .edge.up{top:2.9rem;left:50%;margin-left:-.85rem}
  .edge.down{bottom:.6rem;left:50%;margin-left:-.85rem}
  .edge.left{left:.6rem;top:50%;margin-top:-.85rem}
  .edge.right{right:.6rem;top:50%;margin-top:-.85rem}
  .null{opacity:.4;font-style:italic}
  .empty{padding:1.5rem 1.05rem;color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>
<div class="head">
  <h1 id="file"></h1>
  <p class="origin" id="origin"></p>
  <ul class="facts" id="facts"></ul>
  <div id="notes"></div>
  <div class="bar">
    <span class="group">
      <button id="prev" title="Previous hundred rows">&uarr;</button>
      <span class="where" id="where"></span>
      <button id="next" title="Next hundred rows">&darr;</button>
    </span>
    <span class="group">
      <button id="cprev" title="Previous columns">&lsaquo;</button>
      <span class="where" id="cwhere"></span>
      <button id="cnext" title="Next columns">&rsaquo;</button>
    </span>
    <input id="filter" type="text" placeholder="filter columns" autocomplete="off">
  </div>
</div>
<div class="grid">
  <div class="scroller" id="scroller"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
  <button class="edge up" id="eup" title="Previous rows">&uarr;</button>
  <button class="edge down" id="edown" title="Next rows">&darr;</button>
  <button class="edge left" id="eleft" title="Previous columns">&lsaquo;</button>
  <button class="edge right" id="eright" title="Next columns">&rsaquo;</button>
</div>
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
  if (state.symbol) $('file').appendChild(text('span', state.symbol, 'symbol'));
  $('origin').textContent = state.uri;

  const facts = $('facts');
  facts.replaceChildren(...state.facts.map((fact) => text('li', fact)));

  const notes = state.error ? [state.error, ...state.notes] : state.notes;
  $('notes').replaceChildren(...notes.map((note) => text('p', note, 'note')));

  // The range you are looking at, and nothing else: how many rows and columns
  // the file has is a fact about the file, and the header already said it.
  const last = state.rowStart + state.rows.length;
  $('where').textContent = state.rows.length ? state.rowStart + '–' + (last - 1) : '—';
  $('prev').disabled = state.rowStart <= 0;
  $('next').disabled = !state.more;

  const shown = state.columns.length;
  $('cwhere').textContent = shown
    ? (state.columnStart + 1) + '–' + (state.columnStart + shown)
    : '—';
  $('cprev').disabled = state.columnStart <= 0;
  $('cnext').disabled = state.columnStart + shown >= state.columnCount;
  if ($('filter').value !== state.filter) $('filter').value = state.filter;

  // Numbers line up under each other or they are not numbers, they are text
  // that happens to be digits. The host already said which family each is.
  const kinds = state.kinds;
  const numeric = state.columns.map((_, i) => kinds[i] === 't-int' || kinds[i] === 't-float');

  const header = document.createElement('tr');
  header.appendChild(text('th', '#', 'index'));
  state.columns.forEach((name, i) => {
    const cell = text('th', name, numeric[i] ? 'num' : undefined);
    if (state.dtypes[i]) cell.appendChild(text('span', state.dtypes[i], 'dtype ' + kinds[i]));
    header.appendChild(cell);
  });
  $('head').replaceChildren(header);

  const body = document.createDocumentFragment();
  state.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(text('td', String(state.rowStart + i), 'index'));
    row.forEach((value, c) => {
      const align = numeric[c] ? ' num' : '';
      // A null carries no dtype tint: an empty cell should be the one thing on
      // the row that is not washed in its column's colour.
      tr.appendChild(value === null
        ? text('td', 'null', 'null' + align)
        : text('td', value, kinds[c] + align));
    });
    body.appendChild(tr);
  });
  $('body').replaceChildren(body);

  const nothing = !state.rows.length;
  $('scroller').hidden = nothing;
  $('empty').hidden = !nothing;
  $('empty').textContent = state.error ? '' : 'Nothing to show here.';
  $('scroller').scrollTop = 0;
  edges();
}

/**
 * The arrows on the table's own edges. They appear where you actually ran out —
 * at the bottom of the rows you have, at the right of the columns you have —
 * and only when there is more in that direction. An arrow floating over the
 * middle of the data is noise; one at the edge you just hit is the next page.
 */
function edges() {
  if (!state) return;
  const el = $('scroller');
  const room = 2;
  const atTop = el.scrollTop <= room;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - room;
  const atLeft = el.scrollLeft <= room;
  const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - room;
  const drawn = state.rows.length;
  $('eup').hidden = !(atTop && state.rowStart > 0 && drawn);
  $('edown').hidden = !(atBottom && state.more && drawn);
  $('eleft').hidden = !(atLeft && state.columnStart > 0 && drawn);
  $('eright').hidden =
    !(atRight && state.columnStart + state.columns.length < state.columnCount && drawn);
}

const rowsBack = () => send({ rowStart: Math.max(0, state.rowStart - state.pageSize) });
const rowsOn = () => send({ rowStart: state.rowStart + state.pageSize });
const colsBack = () => send({ columnStart: Math.max(0, state.columnStart - state.columnWindow) });
const colsOn = () => send({ columnStart: state.columnStart + state.columnWindow });

for (const [id, go] of [['prev', rowsBack], ['eup', rowsBack], ['next', rowsOn], ['edown', rowsOn],
                        ['cprev', colsBack], ['eleft', colsBack], ['cnext', colsOn],
                        ['cnext', colsOn], ['eright', colsOn]]) {
  $(id).addEventListener('click', go);
}
$('scroller').addEventListener('scroll', edges);
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
