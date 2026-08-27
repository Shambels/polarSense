import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { dtypeClass, fmt, frameFacts, frameNotes } from './facts.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';
import { shell } from './table.page.js';

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
  current.webview.html = shell(current.webview.cspSource);
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
