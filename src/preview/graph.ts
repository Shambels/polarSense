import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Agg, Chart, ChartKind, Grain } from '../schema/chart.js';
import { familyOf, defaultAxis } from '../schema/chart.js';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { readSettings } from '../config.js';
import { frameFacts, frameNotes } from './facts.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';
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
  frame: ResolvedFrame;
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
}

export async function showGraph(api: PolarSenseApi, at?: FrameTarget): Promise<void> {
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

  // A list or struct column has no shape to draw, so it is not offered — an
  // option that can only produce a refusal is worse than no option.
  const columns = frame.columns
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

  view = { frame, columns, x, y: undefined, kind: undefined };
  last = undefined;

  const current = ensurePanel(api);
  current.title = path.basename(frame.uri) || 'PolarSense';
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

/** What the page can ask for: a column on either axis, a chart, an aggregate. */
interface Intent {
  type?: string;
  x?: string;
  y?: string;
  kind?: ChartKind;
  agg?: Agg;
  grain?: Grain;
}

async function onMessage(api: PolarSenseApi, message: Intent): Promise<void> {
  if (!panel || !view) return;

  if (message?.type === 'ready') {
    if (last) { void panel.webview.postMessage(last); return; }
    await update(api);
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
  }
  if (typeof message?.y === 'string') {
    const wanted = message.y === '' || message.y === view.x ? undefined : message.y;
    if (wanted !== view.y && (wanted === undefined || known(wanted))) {
      view.y = wanted;
      view.kind = undefined;
    }
  }
  if (typeof message?.kind === 'string') view.kind = message.kind;
  if (typeof message?.agg === 'string') view.agg = message.agg;
  // Empty is "not grouped": the picker's own first option, not a missing value.
  if (typeof message?.grain === 'string') view.grain = message.grain || undefined;

  await update(api);
}

/** Read the columns the current view names, aggregate them, and send the points. */
async function update(api: PolarSenseApi): Promise<void> {
  if (!panel || !view) return;
  const current = view;

  const result = await api.readChart(current.frame, {
    x: current.x,
    y: current.y,
    kind: current.kind,
    agg: current.agg,
    grain: current.grain,
    maxRows: readSettings().graphMaxRows
  });

  last = payload(current, result.chart, result.error);
  void panel.webview.postMessage(last);
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
  agg: Agg | '';
  aggs: Agg[];
  seriesNames: string[];
  grain: Grain | '';
  grains: Grain[];
  xLabel: string;
  yLabel: string;
  xNumeric: boolean;
  domain?: [number, number];
  ticks: { x: number; label: string }[];
  points: { x: number; y: number; label: string; series?: string }[];
  empty?: string;
  error?: string;
}

function payload(
  current: View,
  chart: Chart | undefined,
  error: RowsFailure | undefined
): Payload {
  const notes = frameNotes(current.frame);
  for (const note of chart?.notes ?? []) notes.push(note);

  return {
    file: path.basename(current.frame.uri),
    uri: current.frame.uri,
    symbol: current.frame.symbol,
    facts: frameFacts(current.frame),
    notes,
    columns: current.columns,
    x: chart?.x ?? current.x,
    y: chart?.y ?? '',
    kind: chart?.kind ?? '',
    kinds: chart?.kinds ?? [],
    agg: chart?.agg ?? '',
    aggs: chart?.aggs ?? [],
    seriesNames: chart?.seriesNames ?? [],
    grain: chart?.grain ?? '',
    grains: chart?.grains ?? [],
    xLabel: chart?.xLabel ?? '',
    yLabel: chart?.yLabel ?? '',
    xNumeric: chart?.xNumeric ?? false,
    domain: chart?.domain,
    ticks: chart?.ticks ?? [],
    points: chart?.points ?? [],
    // How many rows were read is not sent: where it mattered — a prefix of a
    // CSV, a sample cut short by graph.maxRows — the chart already says so in a
    // note, and a count that only ever confirmed the file was read whole was a
    // line of chrome above the plot rather than a fact about it.
    empty: chart?.empty,
    error: error && explain(error, current.frame.kind)
  };
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
