import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { readSettings } from '../config.js';
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
 *
 * The state lives in a `TableSession` rather than in this module because there
 * is now more than one door onto the same grid: the command opens one panel and
 * reuses it, while the parquet editor gets one per open file. Same page, same
 * protocol, different owner.
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
  /** The column the rows are ordered by, when a header has been clicked. */
  sort?: { column: string; desc: boolean };
  /**
   * Sort the whole file rather than the first `sort.maxRows` of it, because the
   * note said the cap had been reached and someone pressed the button under it.
   * A panel decision, not a setting: the cap is the default for every file, and
   * this is one file where you asked for all of it.
   */
  sortAll: boolean;
}

/** What the webview can ask for: a page, a column window, a filter, or a redraw. */
export interface Intent {
  type?: string;
  rowStart?: number;
  columnStart?: number;
  filter?: string;
  /** A header was clicked: this column name. */
  sort?: string;
}

/**
 * One grid on one webview: what is being looked at, and the reads that answer.
 *
 * It owns no panel. Whoever created the webview keeps it alive, hands messages
 * here and drops the session when the view goes — which is what lets the same
 * grid live in a panel the command reuses and in an editor tab per file.
 */
export class TableSession {
  private view: View;
  /** The last payload sent, so a webview that was hidden can be restored without a read. */
  private last: unknown;

  constructor(
    private readonly api: PolarSenseApi,
    private readonly webview: vscode.Webview,
    frame: ResolvedFrame,
    /** Whether the page offers its own way into the details and graph panels. */
    private readonly panels = false
  ) {
    this.view = {
      frame,
      columns: frame.columns.map((column) => column.name),
      resolved: false,
      rowStart: 0,
      columnStart: 0,
      filter: '',
      sortAll: false
    };
  }

  async handle(message: Intent): Promise<void> {
    // The webview is reloaded whenever it has been hidden, and it comes back with
    // no state at all — so it asks, rather than the host guessing when to tell it.
    if (message?.type === 'ready') {
      if (this.last) { void this.webview.postMessage(this.last); return; }
      await this.update();
      return;
    }

    if (message?.type === 'sortAll') {
      this.view.sortAll = !this.view.sortAll;
      // A different set of rows was ordered, so the page numbers mean something
      // else than they did a moment ago.
      this.view.rowStart = 0;
    }

    if (typeof message?.sort === 'string') {
      // Ascending, then descending, then the file's own order back — which is a
      // real answer here rather than a null state, because the order rows are
      // written in is a fact about the file.
      const column = message.sort;
      const was = this.view.sort;
      this.view.sort = was?.column !== column
        ? { column, desc: false }
        : was.desc ? undefined : { column, desc: true };
      // A new order makes the old offset meaningless.
      this.view.rowStart = 0;
    }

    if (typeof message?.filter === 'string' && message.filter !== this.view.filter) {
      this.view.filter = message.filter;
      // A narrower list makes the old window meaningless.
      this.view.columnStart = 0;
    }
    if (typeof message?.rowStart === 'number') {
      this.view.rowStart = Math.max(0, message.rowStart);
    }
    if (typeof message?.columnStart === 'number') {
      this.view.columnStart = Math.max(0, message.columnStart);
    }
    await this.update();
  }

  /** Read the page the current view describes, and send exactly that. */
  private async update(): Promise<void> {
    const current = this.view;
    const matching = filtered(current);
    const drawn = matching.slice(current.columnStart, current.columnStart + COLUMN_WINDOW);
    // The cap is read here rather than held, so changing it applies to the next
    // click instead of to the next window.
    const cap = readSettings().sortMaxRows;
    const sort = current.sort && {
      ...current.sort,
      maxRows: current.sortAll ? Number.MAX_SAFE_INTEGER : cap
    };
    const ask = (columns: string[]) =>
      this.api.readRows(current.frame, { columns, rowStart: current.rowStart, limit: PAGE, sort });

    let result = await ask(drawn);

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
        result = await ask(
          filtered(current).slice(current.columnStart, current.columnStart + COLUMN_WINDOW)
        );
      }
    }

    this.last = payload(current, this.panels, cap, result.page, result.error);
    void this.webview.postMessage(this.last);
  }
}

/** The command's panel: one at a time, reused, pointed at whatever resolved last. */
let panel: vscode.WebviewPanel | undefined;
let session: TableSession | undefined;

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

  const current = ensurePanel();
  current.title = path.basename(frame.uri) || 'PolarSense';
  session = new TableSession(api, current.webview, frame);
  // A fresh document each time the command runs: a new frame is a new table, and
  // the webview asks for its first page as soon as it has loaded.
  current.webview.html = shell(current.webview.cspSource);
  current.reveal(vscode.ViewColumn.Beside, true);
}

function ensurePanel(): vscode.WebviewPanel {
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
  panel.onDidDispose(() => { panel = undefined; session = undefined; });
  // The panel outlives the frame it was opened on, so it asks whichever session
  // is current rather than closing over one. The promise goes back to a caller
  // VS Code does not have and a test does.
  panel.webview.onDidReceiveMessage((message) => session?.handle(message));
  return panel;
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
  /** Which column the rows are ordered by, for the arrow on its header. */
  sort?: { column: string; desc: boolean };
  /**
   * The note about how much of the file the order covers, and the button that
   * changes it. Separate from `notes` because it is the one of them you can
   * press: everything else on this panel is a statement.
   */
  sortNote?: { text: string; button: string };
  /** Show the details and graph buttons: true where this grid is the whole file's editor. */
  panels: boolean;
  error?: string;
}

function payload(
  current: View,
  panels: boolean,
  cap: number,
  page: { columns: string[]; dtypes: string[]; rows: (string | null)[][]; rowStart: number;
          rowCount?: number; more: boolean; prefixBytes?: number; sortedRows?: number }
          | undefined,
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
  // Sorting reads a window, and the top of a window is not the top of a file.
  // Saying which is which is the whole difference between a sort and a lie.
  let sortNote: Payload['sortNote'];
  if (page?.sortedRows !== undefined && current.sort) {
    const total = page.rowCount;
    if (total !== undefined && page.sortedRows < total) {
      sortNote = {
        text: `Sorted over the first ${fmt(page.sortedRows)} of ${fmt(total)} rows — ` +
          'the top of that window, not of the file. Ordering all of them reads every ' +
          'row of the columns on screen.',
        button: `Sort all ${fmt(total)} rows`
      };
    } else if (total !== undefined && current.sortAll && total > cap) {
      // The cap is off for this panel, and the way back to it has to be as
      // visible as the way out was.
      sortNote = {
        text: `Sorted over all ${fmt(total)} rows: every one of them was read to ` +
          'order this page.',
        button: `Back to the first ${fmt(cap)}`
      };
    } else if (page.prefixBytes !== undefined) {
      notes.push(
        `Sorted over the ${fmt(page.sortedRows)} rows inside that prefix, which is ` +
        'all of the file this reader can reach.'
      );
    }
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
    sort: current.sort,
    sortNote,
    panels,
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
