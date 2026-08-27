import { newNonce, PANEL_CSS } from './facts.js';

/**
 * The document, once. It holds no data and no marks: every point arrives as a
 * message, and the SVG is built with `createElementNS` and `textContent` — so a
 * category out of someone's parquet file cannot be anything but a label.
 */
export function shell(cspSource: string): string {
  const nonce = newNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  .plot{flex:1;min-height:0;overflow:auto;padding:.4rem 1.05rem 1rem;
    border-top:1px solid var(--vscode-panel-border)}
  /* Width first: the panel is as wide as it is, and the height follows the
     viewBox. A height of 100% let a short panel letterbox the chart into half
     the width it had. */
  svg{width:100%;height:auto;overflow:visible}
  /* The theme's own chart colours, so the marks stay legible in themes nobody
     here has seen — and one colour throughout, because a single series needs
     no legend and a second colour would imply one. */
  .mark{fill:var(--vscode-charts-blue)}
  .line{fill:none;stroke:var(--vscode-charts-blue);stroke-width:1.6;stroke-linejoin:round}
  .dot{fill:var(--vscode-charts-blue);fill-opacity:.55}
  /* One class per line, six deep, because that is how many chart colours the
     theme has. A seventh line would have to repeat one, so there is no seventh. */
  /* Stroke and fill separately: a polyline is fill:none, and one rule setting
     both would paint the area under every line. */
  .s0{stroke:var(--vscode-charts-blue)}  .dot.s0{fill:var(--vscode-charts-blue)}
  .s1{stroke:var(--vscode-charts-orange)} .dot.s1{fill:var(--vscode-charts-orange)}
  .s2{stroke:var(--vscode-charts-green)} .dot.s2{fill:var(--vscode-charts-green)}
  .s3{stroke:var(--vscode-charts-purple)} .dot.s3{fill:var(--vscode-charts-purple)}
  .s4{stroke:var(--vscode-charts-red)}   .dot.s4{fill:var(--vscode-charts-red)}
  .s5{stroke:var(--vscode-charts-yellow)} .dot.s5{fill:var(--vscode-charts-yellow)}
  .legend{display:flex;flex-wrap:wrap;gap:.15rem .7rem;margin:.45rem 0 0;font-size:.74rem}
  .legend span{display:inline-flex;align-items:center;gap:.3rem;color:var(--vscode-descriptionForeground)}
  .legend i{width:.6rem;height:.6rem;border-radius:50%;display:inline-block}
  .legend i.s0{background:var(--vscode-charts-blue)}
  .legend i.s1{background:var(--vscode-charts-orange)}
  .legend i.s2{background:var(--vscode-charts-green)}
  .legend i.s3{background:var(--vscode-charts-purple)}
  .legend i.s4{background:var(--vscode-charts-red)}
  .legend i.s5{background:var(--vscode-charts-yellow)}
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
    <span class="pick"><label for="x" id="xlabel">x</label><select id="x"></select></span>
    <span class="pick"><label for="y">y</label><select id="y"></select></span>
    <span class="pick"><label for="kind">chart</label><select id="kind"></select></span>
    <span class="pick" id="aggpick"><label for="agg">per group</label><select id="agg"></select></span>
    <span class="rows" id="rows"></span>
  </div>
  <div class="legend" id="legend"></div>
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

  // On a bar the x column is the grouping key — one slot per distinct value —
  // so it is called that. Calling it x while the select beside it says "per
  // group" leaves the grouping column unnamed on a panel that has one.
  $('xlabel').textContent = state.kind === 'bar' ? 'group by' : 'x';

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
  // Only a bar of grouped rows has anything to measure: a histogram counts, a
  // scatter draws the rows themselves, and a picker over neither is furniture.
  $('agg').replaceChildren(...state.aggs.map((agg) => option(agg, agg, agg === state.agg)));
  $('aggpick').hidden = !state.aggs.length;

  // The legend is the only thing that says which line is which, so it is drawn
  // from the same order the colours are taken in.
  $('legend').replaceChildren(...state.seriesNames.map((name, i) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = 's' + (i % 6);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(name));
    return item;
  }));

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
  // 1.618:1. The viewBox is the aspect ratio as much as the coordinates:
  // the page scales it to the panel width, and this is the height that comes with it.
  const W = 970;
  const H = 600;
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

  // One line, or one per series: the same drawing either way, run once per group.
  const names = state.seriesNames.length ? state.seriesNames : [undefined];
  const radius = state.kind === 'line' ? 1.8 : 2.6;

  names.forEach((name, i) => {
    const colour = state.seriesNames.length ? ' s' + (i % 6) : '';
    const points = name === undefined
      ? state.points
      : state.points.filter((point) => point.series === name);
    if (!points.length) return;

    if (state.kind === 'line') {
      node.appendChild(svg('polyline', {
        points: points.map((point) => px(point.x) + ',' + py(point.y)).join(' ')
      }, 'line' + colour));
    }
    // The points are drawn either way: a line with a marker on it is where you
    // can see that a run of dates has gaps in it.
    for (const point of points) {
      const dot = svg('circle', { cx: px(point.x), cy: py(point.y), r: radius }, 'dot' + colour);
      dot.appendChild(tooltip(point));
      node.appendChild(dot);
    }
  });

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
  title.textContent = (point.series ? point.series + ' · ' : '') +
    point.label + ' — ' + number(point.y);
  return title;
}

function number(value) {
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toPrecision(4));
  return rounded.toLocaleString('en-US');
}

for (const id of ['x', 'y', 'kind', 'agg']) {
  $(id).addEventListener('change', (event) => vscode.postMessage({ [id]: event.target.value }));
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
