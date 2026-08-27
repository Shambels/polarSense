import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Chart, ChartKind } from '../schema/chart.js';
import { familyOf, defaultAxis } from '../schema/chart.js';
import type { PolarSenseApi, ResolvedFrame, RowsFailure } from '../api.js';
import { readSettings } from '../config.js';
import { fmt, frameFacts, frameNotes, PANEL_CSS } from './facts.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';

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
  current.webview.html = shell(current.webview);
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

/** What the page can ask for: a column on either axis, or a different chart. */
interface Intent {
  type?: string;
  x?: string;
  y?: string;
  kind?: ChartKind;
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
  xLabel: string;
  yLabel: string;
  xNumeric: boolean;
  domain?: [number, number];
  ticks: { x: number; label: string }[];
  points: { x: number; y: number; label: string }[];
  rows: string;
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
    xLabel: chart?.xLabel ?? '',
    yLabel: chart?.yLabel ?? '',
    xNumeric: chart?.xNumeric ?? false,
    domain: chart?.domain,
    ticks: chart?.ticks ?? [],
    points: chart?.points ?? [],
    // What was actually measured, in the words the panels use for it elsewhere.
    rows: chart
      ? `${fmt(chart.rowsRead)} row${chart.rowsRead === 1 ? '' : 's'} read` +
        (chart.complete ? '' : ' (a sample)')
      : '',
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

/**
 * The document, once. It holds no data and no marks: every point arrives as a
 * message, and the SVG is built with `createElementNS` and `textContent` — so a
 * category out of someone's parquet file cannot be anything but a label.
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
  .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.7rem 0 .1rem}
  .pick{display:inline-flex;align-items:center;gap:.35rem}
  .pick label{
    font-size:.66rem;text-transform:uppercase;letter-spacing:.09em;
    color:var(--vscode-descriptionForeground);
  }
  select{
    font-family:inherit;font-size:.78rem;color:var(--vscode-dropdown-foreground);
    background:var(--vscode-dropdown-background);
    border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border,transparent));
    border-radius:5px;padding:.26rem .4rem;max-width:14rem;
  }
  select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  .rows{font-size:.72rem;color:var(--vscode-descriptionForeground);margin-left:auto}
  .plot{flex:1;min-height:0;padding:.4rem 1.05rem 1rem;border-top:1px solid var(--vscode-panel-border)}
  svg{width:100%;height:100%;overflow:visible}
  /* The theme's own chart colours, so the marks stay legible in themes nobody
     here has seen — and one colour throughout, because a single series needs
     no legend and a second colour would imply one. */
  .mark{fill:var(--vscode-charts-blue)}
  .line{fill:none;stroke:var(--vscode-charts-blue);stroke-width:1.6;stroke-linejoin:round}
  .dot{fill:var(--vscode-charts-blue);fill-opacity:.55}
  .axis{stroke:var(--vscode-panel-border);stroke-width:1}
  .rule{stroke:var(--vscode-panel-border);stroke-width:1;stroke-opacity:.45}
  .tick{fill:var(--vscode-descriptionForeground);font-size:10px}
  .tick.end{text-anchor:end}
  .tick.mid{text-anchor:middle}
  .caption{fill:var(--vscode-foreground);font-size:11px;text-anchor:middle;opacity:.8}
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
    <span class="pick"><label for="x">x</label><select id="x"></select></span>
    <span class="pick"><label for="y">y</label><select id="y"></select></span>
    <span class="pick"><label for="kind">chart</label><select id="kind"></select></span>
    <span class="rows" id="rows"></span>
  </div>
</div>
<div class="plot"><svg id="svg"></svg></div>
<div class="empty" id="empty" hidden></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
let state = null;

window.addEventListener('message', (event) => { state = event.data; draw(); });

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function option(value, label, selected) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
}

/** An SVG element, with its attributes. Never a string: marks are drawn, not written. */
function svg(tag, attrs, className) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function label(x, y, value, className) {
  const node = svg('text', { x, y }, 'tick ' + (className || ''));
  node.textContent = value;
  return node;
}

function draw() {
  if (!state) return;
  $('file').textContent = state.file;
  if (state.symbol) $('file').appendChild(text('span', state.symbol, 'symbol'));
  $('origin').textContent = state.uri;
  $('facts').replaceChildren(...state.facts.map((fact) => text('li', fact)));

  const notes = state.error ? [state.error, ...state.notes] : state.notes;
  $('notes').replaceChildren(...notes.map((note) => text('p', note, 'note')));
  $('rows').textContent = state.rows;

  const columns = state.columns.map((column) =>
    [column.name, column.dtype ? column.name + '  ' + column.dtype : column.name]);
  $('x').replaceChildren(...columns.map(([name, shown]) =>
    option(name, shown, name === state.x)));
  $('y').replaceChildren(
    option('', 'none', !state.y),
    ...columns.map(([name, shown]) => option(name, shown, name === state.y))
  );
  $('kind').replaceChildren(...state.kinds.map((kind) => option(kind, kind, kind === state.kind)));
  $('kind').disabled = state.kinds.length < 2;

  const nothing = !state.points.length;
  $('svg').replaceChildren();
  $('svg').style.display = nothing ? 'none' : '';
  $('empty').hidden = !nothing;
  $('empty').textContent = nothing ? (state.empty || state.error || 'Nothing to draw here.') : '';
  if (!nothing) plot();
}

/**
 * The chart itself. One coordinate system, four ways of filling it: bars in
 * slots, bars along a scale, a line, a cloud of points.
 */
function plot() {
  const W = 760;
  const H = 400;
  const left = 58;
  const right = 12;
  const top = 10;
  // Room for a caption under the axis, and for slanted labels above it.
  const bottom = state.xNumeric ? 44 : 78;
  const width = W - left - right;
  const height = H - top - bottom;

  const node = $('svg');
  node.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  const values = state.points.map((point) => point.y);
  const yMax = Math.max(0, ...values);
  const yMin = Math.min(0, ...values);
  const span = yMax - yMin || 1;
  const py = (value) => top + height - ((value - yMin) / span) * height;

  // Four horizontal rules, and the numbers that go with them. A gridline is
  // what makes a bar readable as a quantity rather than as a height.
  for (let i = 0; i <= 4; i++) {
    const value = yMin + (span * i) / 4;
    const y = py(value);
    node.appendChild(svg('line', { x1: left, y1: y, x2: left + width, y2: y }, 'rule'));
    node.appendChild(label(left - 6, y + 3, number(value), 'end'));
  }
  node.appendChild(svg('line', { x1: left, y1: py(Math.max(yMin, 0)), x2: left + width,
    y2: py(Math.max(yMin, 0)) }, 'axis'));

  if (state.kind === 'bar' || state.kind === 'histogram') bars(node, left, top, width, height, py);
  else marks(node, left, top, width, height, py);

  node.appendChild(label(left + width / 2, H - 6, state.xLabel, 'mid'));
  if (state.yLabel) {
    const caption = label(0, 0, state.yLabel, 'mid');
    caption.setAttribute('transform', 'translate(13,' + (top + height / 2) + ') rotate(-90)');
    node.appendChild(caption);
  }
}

function bars(node, left, top, width, height, py) {
  const n = state.points.length;
  const slot = width / n;
  const pad = state.kind === 'histogram' ? Math.min(1, slot * 0.08) : Math.min(8, slot * 0.2);
  const zero = py(0);

  state.points.forEach((point, i) => {
    const y = py(point.y);
    const rect = svg('rect', {
      x: left + slot * i + pad,
      y: Math.min(y, zero),
      width: Math.max(1, slot - pad * 2),
      height: Math.max(1, Math.abs(zero - y))
    }, 'mark');
    rect.appendChild(tooltip(point));
    node.appendChild(rect);
  });

  if (state.xNumeric) { ticks(node, left, top, width, height); return; }

  // A caption per bar where they fit, every other one where they do not, and
  // slanted throughout: a category is a word, and a word does not fit under a
  // twentieth of a panel.
  const step = n > 16 ? 2 : 1;
  state.points.forEach((point, i) => {
    if (i % step) return;
    const x = left + slot * (i + 0.5);
    const caption = label(0, 0, point.label, 'end');
    caption.setAttribute('transform',
      'translate(' + x + ',' + (top + height + 8) + ') rotate(-40)');
    node.appendChild(caption);
  });
}

function marks(node, left, top, width, height, py) {
  const domain = state.domain || extent(state.points.map((point) => point.x));
  const span = domain[1] - domain[0] || 1;
  const px = (value) => left + ((value - domain[0]) / span) * width;

  if (state.kind === 'line') {
    const line = svg('polyline', {
      points: state.points.map((point) => px(point.x) + ',' + py(point.y)).join(' ')
    }, 'line');
    node.appendChild(line);
  }

  // The points are drawn either way: a line with a marker on it is where you
  // can see that a run of dates has gaps in it.
  const radius = state.kind === 'line' ? 1.8 : 2.6;
  for (const point of state.points) {
    const dot = svg('circle', { cx: px(point.x), cy: py(point.y), r: radius }, 'dot');
    dot.appendChild(tooltip(point));
    node.appendChild(dot);
  }

  ticks(node, left, top, width, height);
}

/** The host's ticks, placed. It formats them because it is the side that knows a date from a number. */
function ticks(node, left, top, width, height) {
  const marks = state.ticks;
  if (!marks.length) return;
  const domain = state.domain || extent(marks.map((tick) => tick.x));
  const span = domain[1] - domain[0] || 1;
  for (const tick of marks) {
    const x = left + ((tick.x - domain[0]) / span) * width;
    node.appendChild(label(x, top + height + 14, tick.label, 'mid'));
  }
}

function extent(numbers) {
  return [Math.min(...numbers), Math.max(...numbers)];
}

/** The exact value, on hover. The mark is the shape; this is the number in it. */
function tooltip(point) {
  const title = document.createElementNS(NS, 'title');
  title.textContent = point.label + ' — ' + number(point.y);
  return title;
}

function number(value) {
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toPrecision(4));
  return rounded.toLocaleString('en-US');
}

for (const id of ['x', 'y', 'kind']) {
  $(id).addEventListener('change', (event) => vscode.postMessage({ [id]: event.target.value }));
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** Exported for the tests: the shell holds no points, so this is what to inspect. */
export function lastChart(): unknown {
  return last;
}
