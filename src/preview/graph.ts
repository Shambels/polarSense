import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Agg, Chart, ChartKind, Grain } from '../schema/chart.js';
import { familyOf, defaultAxis, buildChart } from '../schema/chart.js';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { readSettings } from '../config.js';
import { trace } from '../log.js';
import { fmt, frameFacts, frameNotes } from './facts.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';
import { readChartFromKernel, readSchemaFromKernel, kernelAvailable } from './kernel.js';
import type { KernelTarget } from '../schema/kernelSeries.js';
import { shell } from './graph.page.js';

/**
 * The shape of a column, drawn.
 *
 * The panel is a thin thing on purpose: the host reads one or two columns, bins
 * or counts them, and sends a few hundred points; the page turns those points
 * into `<rect>`, `<circle>` and `<polyline>` and knows nothing else. No chart
 * library — four kinds of chart in hand-written SVG cost about 20 KB of bundle,
 * which is what a charting library weighs before it has drawn anything.
 *
 * The rule the table panel established holds here and matters more: **nothing
 * crosses to the webview that is not being drawn.** A histogram of four million
 * rows is thirty numbers. That is the whole point of aggregating in the host,
 * and it is why the message protocol never learns how to carry a column.
 */
let panel: vscode.WebviewPanel | undefined;
let view: View | undefined;
let last: unknown;

interface View {
  /**
   * The file behind the frame. Absent for a frame that exists only in the
   * kernel — built with `pl.DataFrame({...})`, or read from somewhere this
   * analysis cannot follow — which is then drawn from the kernel or not at all.
   */
  frame?: ResolvedFrame;
  /** Set exactly when `frame` is not: what the header and a saved PNG call it. */
  memory?: {
    notebookPath: string;
    /** The variable the cell printed, or `Out[n]` when it printed an expression. */
    name: string;
    /** Rows in the frame, when it is eager; a lazy one is not collected to count. */
    rowCount?: number;
    /** Every column, drawable or not — the header counts the frame, not the picker. */
    columnCount: number;
  };
  /**
   * Where the drawn values come from. `file` is the source behind the frame,
   * read directly — the path that always exists. `kernel` is the frame the
   * notebook cell actually computed, read from its running kernel, which is the
   * only way a transform's result reaches the chart — and, for a frame with no
   * file behind it, the only way it reaches the chart at all.
   */
  source: 'file' | 'kernel';
  /** Set only when `source` is `kernel`: how to reach the computed frame. */
  kernel?: { notebookUri: vscode.Uri; target: KernelTarget };
  /** The columns worth offering — the frame's, without the ones nothing can draw. */
  columns: { name: string; dtype: string }[];
  x: string;
  y?: string;
  /** Set only once the user has overridden it; otherwise the lookup table decides. */
  kind?: ChartKind;
  /**
   * What to measure per group. Unlike the kind it survives a change of columns:
   * a median is a median whichever two columns it is taken over.
   */
  agg?: Agg;
  /**
   * The period a temporal x is grouped into, and the same again: asking for it
   * per month is a question about the data, not about which columns are shown.
   */
  grain?: Grain;
  /**
   * The column each line, bar or colour is split by. It survives a change of x
   * or y for the same reason the aggregate does — "per category" is a question
   * about the data — unless the new axis *is* that column.
   */
  split?: string;
}

export async function showGraph(api: PolarSenseApi, at?: FrameTarget): Promise<void> {
  const target = at ?? cursorTarget();
  if (!target) {
    vscode.window.showInformationMessage(NO_PYTHON);
    return;
  }

  const frame = await api.resolveFrameAt(target.uri, target.position);
  if (!frame) {
    await showInMemory(api, target);
    return;
  }

  // The graph draws the source file by default: no kernel, the same path in a
  // .py file, and exact when nothing has been done to the frame. It reaches for
  // the kernel only where the file cannot answer — a frame the cell transformed
  // (or one the resolver could not follow), in a notebook, with the setting left
  // on, a kernel already running, and something to address the frame by. Never
  // the reverse: the file path is the one that always exists.
  const settings = readSettings();
  const note = target.notebook;
  const addressable = !!note && (note.executionOrder !== undefined || !!frame.symbol);
  const wantKernel = settings.graphUseKernel && addressable
    && (frame.transformed || !frame.certain);
  const kernel = wantKernel && note && await kernelAvailable(note.uri)
    ? {
        notebookUri: note.uri,
        target: { outputRef: note.executionOrder, symbol: frame.symbol } as KernelTarget
      }
    : undefined;

  await showGraphFor(api, frame, kernel);
}

/**
 * The same panel on a frame the caller already has, and optionally a kernel to
 * read it from. The parquet editor's Graph button comes through here with
 * neither a cursor nor a kernel: a file is a frame with nothing done to it.
 */
export async function showGraphFor(
  api: PolarSenseApi,
  frame: ResolvedFrame,
  kernel?: { notebookUri: vscode.Uri; target: KernelTarget }
): Promise<void> {
  // Kernel-backed, the real computed columns are all readable, so they are what
  // is offered. On the file path a transformed frame can draw only the columns
  // the file actually holds — offering its computed columns would be offering
  // names that draw nothing, which is the one thing worse than offering fewer.
  const offer = kernel
    ? frame.columns
    : frame.transformed ? frame.sourceColumns : frame.columns;

  open(api, { frame, source: kernel ? 'kernel' : 'file', kernel }, offer);
}

/**
 * A graph of a frame the resolver found no file for — the cell built it in
 * memory, or read it from a path that only exists once the code runs.
 *
 * The file path's answer here was "nothing to draw", and it was the wrong one
 * whenever the frame was sitting in a running kernel: the table under the cell
 * is proof it exists. So the kernel is asked for the frame's schema, which is
 * what the pickers need before a single value is read, and from then on the
 * panel is the same kernel-backed panel a computed frame gets.
 *
 * It stays behind the same gate as the rest of the kernel path —
 * `graph.useKernel`, a kernel already running, an address to find the frame by
 * — and each miss says which of those it was, because "no file behind it" alone
 * tells someone looking at the table nothing about how to get a chart of it.
 */
async function showInMemory(api: PolarSenseApi, target: FrameTarget): Promise<void> {
  const note = target.notebook;
  const address: KernelTarget | undefined =
    note && (note.executionOrder !== undefined || note.symbol)
      ? { outputRef: note.executionOrder, symbol: note.symbol }
      : undefined;
  if (!note || !address) {
    vscode.window.showInformationMessage(target.missing);
    return;
  }
  if (!readSettings().graphUseKernel) {
    vscode.window.showInformationMessage(
      `${target.missing} Turn on polarsense.graph.useKernel to graph it from the ` +
      'notebook’s running kernel instead.'
    );
    return;
  }

  const read = await readSchemaFromKernel(note.uri, address);
  if (!read.schema) {
    vscode.window.showInformationMessage(inMemoryMiss(target.missing, read.miss));
    return;
  }

  const name = note.symbol ?? `Out[${note.executionOrder}]`;
  open(api, {
    memory: {
      notebookPath: note.uri.fsPath,
      name,
      rowCount: read.schema.rowCount,
      columnCount: read.schema.columns.length
    },
    source: 'kernel',
    kernel: { notebookUri: note.uri, target: address }
  }, read.schema.columns);
}

function inMemoryMiss(missing: string, miss: string | undefined): string {
  if (miss === 'no-kernel') {
    return `${missing} Run the notebook and the graph can draw it from the kernel.`;
  }
  const why =
    miss === 'no-target' ? 'it does not hold what this cell printed any more — run the cell again'
    : miss === 'not-a-frame' ? 'what this cell printed is not a polars DataFrame or LazyFrame'
    : miss === 'no-polars' ? 'polars cannot be imported there'
    : 'the log has the detail';
  return 'PolarSense: this cell’s frame has no file behind it, and the notebook’s ' +
    `kernel could not hand it over either: ${why}.`;
}

/** Open (or reuse) the panel on a view, offering `offer` minus what cannot be drawn. */
function open(
  api: PolarSenseApi,
  init: Pick<View, 'frame' | 'memory' | 'source' | 'kernel'>,
  offer: readonly { name: string; dtype: string }[]
): void {
  // A list or struct column has no shape to draw, so it is not offered — an
  // option that can only produce a refusal is worse than no option.
  const columns = offer
    .filter((column) => familyOf(column.dtype) !== 'nested')
    .map((column) => ({ name: column.name, dtype: column.dtype }));

  const x = defaultAxis(columns);
  if (!x) {
    vscode.window.showInformationMessage(
      'PolarSense: this frame has no column that can be drawn — every one of them ' +
      'is a list or a struct.'
    );
    return;
  }

  view = { ...init, columns, x, y: undefined, kind: undefined };
  last = undefined;

  const current = ensurePanel(api);
  current.title = init.frame
    ? path.basename(init.frame.uri) || 'PolarSense'
    : init.memory?.name ?? 'PolarSense';
  current.webview.html = shell(current.webview.cspSource);
  current.reveal(vscode.ViewColumn.Beside, true);
}

function ensurePanel(api: PolarSenseApi): vscode.WebviewPanel {
  if (panel) return panel;
  panel = vscode.window.createWebviewPanel(
    'polarsense.graph',
    'PolarSense',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    // Same bargain as the table: scripts, because redrawing the document on
    // every axis change loses your place — and nothing loaded from anywhere,
    // with every value arriving as data rather than as markup.
    { enableScripts: true, localResourceRoots: [] }
  );
  panel.onDidDispose(() => { panel = undefined; view = undefined; last = undefined; });
  panel.webview.onDidReceiveMessage((message) => onMessage(api, message));
  return panel;
}

/** What the page can ask for: a column on either axis, a chart, an aggregate, a file. */
interface Intent {
  type?: string;
  x?: string;
  y?: string;
  kind?: ChartKind;
  agg?: Agg;
  grain?: Grain;
  /** A column name to split by, or empty for no split. */
  split?: string;
  /** Set on an `export`: the drawn chart, rasterized by the page, base64 PNG. */
  png?: string;
}

async function onMessage(api: PolarSenseApi, message: Intent): Promise<void> {
  if (!panel || !view) return;

  if (message?.type === 'ready') {
    if (last) { void panel.webview.postMessage(last); return; }
    await update(api);
    return;
  }

  if (message?.type === 'export') {
    await savePng(message.png);
    return;
  }

  const known = (name: string | undefined) =>
    view!.columns.some((column) => column.name === name);

  if (typeof message?.x === 'string' && known(message.x) && message.x !== view.x) {
    view.x = message.x;
    // The override belonged to the old pair of columns, and a scatter of two
    // numbers is not a scatter once one of them is a month.
    view.kind = undefined;
    if (view.y === view.x) view.y = undefined;
    if (view.split === view.x) view.split = undefined;
  }
  if (typeof message?.y === 'string') {
    const wanted = message.y === '' || message.y === view.x ? undefined : message.y;
    if (wanted !== view.y && (wanted === undefined || known(wanted))) {
      view.y = wanted;
      view.kind = undefined;
      if (view.split === view.y) view.split = undefined;
    }
  }
  if (typeof message?.split === 'string') {
    // Empty is "not split", the menu's own first entry. A name that is not one
    // of the offered columns, or is already on an axis, changes nothing.
    const wanted = message.split || undefined;
    if (wanted === undefined ||
        (known(wanted) && wanted !== view.x && wanted !== view.y)) {
      view.split = wanted;
    }
  }
  if (typeof message?.kind === 'string') view.kind = message.kind;
  if (typeof message?.agg === 'string') view.agg = message.agg;
  // Empty is "not grouped": the picker's own first option, not a missing value.
  if (typeof message?.grain === 'string') view.grain = message.grain || undefined;

  await update(api);
}

/**
 * The drawn chart, written where the user says.
 *
 * The picture is made in the page and not here: the host has no canvas, and the
 * colours on that chart are the theme's, which only the webview can resolve. So
 * this half does the two things a webview cannot — ask for a path and write
 * bytes — and nothing else. The name is a suggestion built from what is drawn,
 * because a folder of `chart.png` is a folder of one chart.
 */
async function savePng(png: string | undefined): Promise<void> {
  if (!view) return;
  if (!png) {
    vscode.window.showInformationMessage(
      'PolarSense: the chart could not be turned into an image.'
    );
    return;
  }

  const origin = view.frame?.uri ?? view.memory?.notebookPath ?? '';
  const stem = view.frame
    ? path.basename(view.frame.uri).replace(/\.[^.]+$/, '') || 'chart'
    : view.memory?.name ?? 'chart';
  // The split the chart applied, not the one asked for: a label y is the split
  // then, and the one in the view was set aside.
  const applied = (last as Payload | undefined)?.split;
  const name = [stem, view.x, view.y, applied && `by-${applied}`]
    .filter((part): part is string => !!part)
    .join('-')
    .replace(/[^\w.-]+/g, '_') + '.png';
  // A frame read over https has no directory to offer; the dialog opens
  // wherever VS Code would open it rather than somewhere invented.
  const dir = path.dirname(origin);
  const target = await vscode.window.showSaveDialog({
    defaultUri: path.isAbsolute(dir) ? vscode.Uri.file(path.join(dir, name)) : undefined,
    filters: { 'PNG image': ['png'] },
    saveLabel: 'Save chart'
  });
  if (!target) return;

  try {
    await vscode.workspace.fs.writeFile(target, new Uint8Array(Buffer.from(png, 'base64')));
    trace(`graph: chart written to ${target.fsPath}`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `PolarSense: the chart could not be written — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Read the columns the current view names, aggregate them, and send the points. */
async function update(api: PolarSenseApi): Promise<void> {
  if (!panel || !view) return;
  const current = view;
  const request = {
    x: current.x,
    y: current.y,
    kind: current.kind,
    agg: current.agg,
    grain: current.grain,
    split: current.split,
    maxRows: readSettings().graphMaxRows
  };

  if (current.source === 'kernel' && current.kernel) {
    // Only the one or two columns on screen are read, capped the same way the
    // file read is: the kernel serializes those and nothing else, so a chart of
    // a computed frame costs the same message as a chart of a file.
    const columns = [...new Set([current.x, current.y, current.split]
      .filter((name): name is string => !!name))];
    const result = await readChartFromKernel(
      current.kernel.notebookUri, current.kernel.target, columns, request.maxRows
    );
    // A frame that was there when the panel opened and is gone now — a kernel
    // restarted, a variable reassigned — is not the file's answer either, so it
    // says what happened rather than quietly drawing the source in its place.
    last = result.read
      ? payload(current, buildChart(result.read, request), undefined)
      : kernelMiss(current);
  } else if (current.frame) {
    const result = await api.readChart(current.frame, request);
    last = payload(current, result.chart, result.error);
  }

  void panel.webview.postMessage(last);
}

/** What the panel shows when the kernel it opened against can no longer answer. */
function kernelMiss(current: View): Payload {
  const then = current.frame
    ? 'Close the graph and open it again to draw the source file instead.'
    // No file to fall back to, so the only way forward is the kernel again.
    : 'This frame has no file behind it to draw instead: run its cell again and ' +
      'reopen the graph.';
  return {
    ...payload(current, undefined, undefined),
    empty: 'PolarSense could not read this frame from the kernel just now — it may ' +
      `have been restarted, or the variable is gone. ${then}`
  };
}

interface Payload {
  file: string;
  uri: string;
  symbol?: string;
  facts: string[];
  notes: string[];
  columns: { name: string; dtype: string }[];
  x: string;
  y: string;
  kind: ChartKind | '';
  kinds: ChartKind[];
  /** The measured axis is a duration; the page formats its ticks as a span. */
  yDuration: boolean;
  agg: Agg | '';
  aggs: Agg[];
  seriesNames: string[];
  /** The column the chart is split by, or empty. */
  split: string;
  /**
   * The columns a split can be asked for by — every drawable one but the two on
   * the axes — or empty where the chart cannot take a split.
   */
  splits: { name: string; dtype: string }[];
  grain: Grain | '';
  grains: Grain[];
  xLabel: string;
  yLabel: string;
  xNumeric: boolean;
  domain?: [number, number];
  ticks: { x: number; label: string }[];
  points: { x: number; y: number; label: string; series?: string; n?: number }[];
  empty?: string;
  error?: string;
}

function payload(
  current: View,
  chart: Chart | undefined,
  error: RowsFailure | undefined
): Payload {
  const kernelBacked = current.source === 'kernel';
  // On the kernel path the transforms have been applied, so the file-path
  // caveats — the "transforms not applied" fact and its note — would be false.
  // Drop them, and say instead where these numbers came from.
  const facts = current.frame
    ? frameFacts(current.frame)
        .filter((fact) => !kernelBacked || fact !== 'transforms not applied')
    : memoryFacts(current);
  if (kernelBacked) facts.push('from the kernel');

  const notes = current.frame
    ? frameNotes(current.frame)
        .filter((note) => !kernelBacked || !note.startsWith('The frame here has transforms applied'))
    : [];
  for (const note of chart?.notes ?? []) notes.push(note);

  // A frame with no file is named after the notebook that holds it and the
  // variable it printed — the same two things a file frame's header shows.
  const origin = current.frame?.uri ?? current.memory?.notebookPath ?? '';
  return {
    file: path.basename(origin),
    uri: origin,
    symbol: current.frame?.symbol ?? current.memory?.name,
    facts,
    notes,
    columns: current.columns,
    x: chart?.x ?? current.x,
    y: chart?.y ?? '',
    kind: chart?.kind ?? '',
    kinds: chart?.kinds ?? [],
    agg: chart?.agg ?? '',
    aggs: chart?.aggs ?? [],
    seriesNames: chart?.seriesNames ?? [],
    split: chart?.split ?? '',
    splits: chart?.splittable
      ? current.columns.filter((column) => column.name !== chart.x && column.name !== chart.y)
      : [],
    grain: chart?.grain ?? '',
    grains: chart?.grains ?? [],
    xLabel: chart?.xLabel ?? '',
    yLabel: chart?.yLabel ?? '',
    xNumeric: chart?.xNumeric ?? false,
    yDuration: chart?.yDuration ?? false,
    domain: chart?.domain,
    ticks: chart?.ticks ?? [],
    points: chart?.points ?? [],
    // How many rows were read is not sent: where it mattered — a prefix of a
    // CSV, a sample cut short by graph.maxRows — the chart already says so in a
    // note, and a count that only ever confirmed the file was read whole was a
    // line of chrome above the plot rather than a fact about it.
    empty: chart?.empty,
    error: error && explain(error, current.frame?.kind ?? 'in memory')
  };
}

/** The header of a frame with no file: what the kernel said about its shape. */
function memoryFacts(current: View): string[] {
  const rows = current.memory?.rowCount;
  const count = current.memory?.columnCount ?? current.columns.length;
  return [
    rows === undefined ? undefined : `${fmt(rows)} row${rows === 1 ? '' : 's'}`,
    `${fmt(count)} column${count === 1 ? '' : 's'}`,
    'in memory'
  ].filter((fact): fact is string => !!fact);
}

function explain(error: RowsFailure, kind: string): string {
  switch (error) {
    case 'unsupported-format':
      return `Charts are drawn from parquet and CSV so far. This frame is ${kind}: ` +
        'its schema is known, its values are not read yet.';
    case 'file-not-found': return 'The file behind this frame is not there any more.';
    case 'unsupported-scheme': return 'This location cannot be read from here.';
    default: return 'The values could not be read. The log has the detail.';
  }
}
