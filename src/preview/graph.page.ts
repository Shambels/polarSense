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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>PolarSense</title>
<style>${PANEL_CSS}
  .head{padding:.85rem 1.05rem .6rem}
  /* The gap above is wider than the gaps inside the row on purpose: the facts
     and notes above are what this frame is, the row is what to draw of it. */
  .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-start;margin:1.7rem 0 .1rem}
  .pick{display:inline-flex;align-items:center;gap:.35rem}
  /* An author rule beats the browser's own [hidden]{display:none}, so a
     .pick with nothing to offer stayed on screen without this. */
  .pick[hidden]{display:none}
  /* The period picker sits under the column it groups: it is an argument to
     that select, not a fifth control of equal standing. A grid rather than two
     rows of label-and-select, because a grid column is as wide as its widest
     label — which is what puts the two selects on the same left edge whether
     the one above them says x or group by. */
  .pick.stack{display:inline-grid;grid-template-columns:auto auto;
    gap:.3rem .35rem;align-items:center;justify-items:start}
  /* The tail of the row hangs off the right edge rather than off the left one. */
  .pick.right{margin-left:auto}
  .pick label,.pick .cap{
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
  /* Four charts, four pictures: the names were never the point, and a shape is
     read faster than a word in a list that has to be opened to be seen. */
  .kinds{
    display:inline-flex;gap:.1rem;padding:.12rem;border-radius:5px;
    background:var(--vscode-dropdown-background);
    border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border,transparent));
  }
  .kinds button{
    display:inline-flex;align-items:center;justify-content:center;
    width:1.7rem;height:1.5rem;padding:0;border:0;border-radius:4px;
    background:none;color:var(--vscode-dropdown-foreground);cursor:pointer;
  }
  .kinds button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}
  /* Which one is chosen is carried by the button and not only by its icon: a
     theme whose active colours are unset still leaves a filled cell behind. */
  .kinds button[aria-checked="true"]{
    background:var(--vscode-inputOption-activeBackground,var(--vscode-toolbar-hoverBackground));
    color:var(--vscode-inputOption-activeForeground,var(--vscode-foreground));
    box-shadow:inset 0 0 0 1px var(--vscode-inputOption-activeBorder,transparent);
  }
  .kinds button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  .kinds button:disabled{cursor:default}
  .kinds svg{width:15px;height:15px;fill:currentColor}
  /* The line icon is the one shape that is a stroke rather than a fill, and it
     says so here: a presentation attribute would lose to the rule above it. */
  .kinds polyline{fill:none;stroke:currentColor;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}
  /* The export sits beside the chart types and not inside them: it does
     something rather than choosing something, so it gets its own box at the
     same height rather than a seventh cell in the group. */
  .tool{
    display:inline-flex;align-items:center;justify-content:center;
    width:1.76rem;padding:0;border-radius:5px;
    /* Its height is the group's beside it rather than a number of its own:
       the two boxes are one row, and a row that is nearly level reads worse
       than one that is level. */
    align-self:stretch;
    background:var(--vscode-dropdown-background);
    color:var(--vscode-dropdown-foreground);cursor:pointer;
    border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border,transparent));
  }
  .tool:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}
  .tool:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  /* Nothing drawn is nothing to export, and a control that can only fail
     should not invite the click that proves it. */
  .tool:disabled{cursor:default;opacity:.45}
  .tool svg{width:15px;height:15px;fill:currentColor}
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
    <span class="pick stack">
      <label for="x" id="xlabel">x</label><select id="x"></select>
      <label for="grain" class="grainrow">by</label><select id="grain" class="grainrow"></select>
    </span>
    <span class="pick"><label for="y">y</label><select id="y"></select></span>
    <span class="pick" id="aggpick"><label for="agg">per group</label><select id="agg"></select></span>
    <span class="pick right">
      <span class="kinds" id="kind" role="radiogroup" aria-labelledby="kindcap"></span>
      <button type="button" id="save" class="tool" disabled
        title="Save chart as PNG" aria-label="Save chart as PNG"></button>
    </span>
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

/**
 * A chart type, drawn. Each icon is the chart in miniature — bars in slots, a
 * distribution, a line with a bend in it, a scatter of points — so the row can
 * be read without opening anything, which a list of names could not be.
 */
const ICONS = {
  bar: [
    ['rect', { x: 2, y: 8, width: 3.2, height: 6 }],
    ['rect', { x: 6.4, y: 3, width: 3.2, height: 11 }],
    ['rect', { x: 10.8, y: 6, width: 3.2, height: 8 }]
  ],
  histogram: [
    ['rect', { x: 1, y: 10, width: 2.6, height: 4 }],
    ['rect', { x: 4, y: 6.5, width: 2.6, height: 7.5 }],
    ['rect', { x: 7, y: 2.5, width: 2.6, height: 11.5 }],
    ['rect', { x: 10, y: 7.5, width: 2.6, height: 6.5 }],
    ['rect', { x: 13, y: 11, width: 2, height: 3 }]
  ],
  line: [
    ['polyline', { points: '2,12 6,7.5 9.5,9.5 14,3' }]
  ],
  scatter: [
    ['circle', { cx: 3.4, cy: 11.4, r: 1.6 }],
    ['circle', { cx: 7, cy: 6.4, r: 1.6 }],
    ['circle', { cx: 10.2, cy: 10, r: 1.6 }],
    ['circle', { cx: 13.4, cy: 4, r: 1.6 }]
  ]
};

/** The export, drawn: an arrow onto a line, which is what a download looks like everywhere. */
const SAVE_ICON = [
  ['rect', { x: 7.1, y: 1.5, width: 1.8, height: 5.4 }],
  ['polygon', { points: '4.6,6.4 11.4,6.4 8,11.1' }],
  ['rect', { x: 2.6, y: 12.5, width: 10.8, height: 1.6, rx: 0.6 }]
];

/** An SVG element, with its attributes. Never a string: marks are drawn, not written. */
function svg(tag, attrs, className) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

/** A picture, from its shapes — or an empty one where there is no picture. */
function icon(shapes) {
  const node = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
  for (const [tag, attrs] of shapes || []) node.appendChild(svg(tag, attrs));
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
  // A radio group rather than a select: four options that each have a picture
  // are worth the width, and the chosen one is then visible without a click.
  // The name stays as the tooltip and as the accessible name — the icon is a
  // faster way to read the list, not a replacement for knowing what it says.
  $('kind').replaceChildren(...state.kinds.map((kind) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(kind === state.kind));
    button.setAttribute('aria-label', kind);
    button.title = kind;
    // One possible chart is not a choice, and a control that cannot change
    // anything should not invite the click that proves it.
    button.disabled = state.kinds.length < 2;
    button.appendChild(icon(ICONS[kind]));
    button.addEventListener('click', () => vscode.postMessage({ kind }));
    return button;
  }));
  // Only a bar of grouped rows has anything to measure: a histogram counts, a
  // scatter draws the rows themselves, and a picker over neither is furniture.
  $('agg').replaceChildren(...state.aggs.map((agg) => option(agg, agg, agg === state.agg)));
  $('aggpick').hidden = !state.aggs.length;
  // Only a date can be grouped into periods, and the first option is not one:
  // a timestamp left alone is a different chart, not a missing choice.
  $('grain').replaceChildren(
    option('', 'exact', !state.grain),
    ...state.grains.map((grain) => option(grain, grain, grain === state.grain))
  );
  for (const node of document.querySelectorAll('.grainrow')) node.hidden = !state.grains.length;

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
  $('save').disabled = nothing;
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
    node.appendChild(label(left - 6, y + 3, yfmt(value), 'end'));
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
    point.label + ' — ' + yfmt(point.y);
  return title;
}

function number(value) {
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toPrecision(4));
  return rounded.toLocaleString('en-US');
}

/** The value on the measured axis: a span of time where it is one, a number otherwise. */
function yfmt(value) {
  return state && state.yDuration ? duration(value) : number(value);
}

/**
 * Microseconds as a short human span — 13d 19h, 15m, 500µs — the largest two
 * units that carry it. The kernel hands durations over in microseconds, so that
 * is the unit assumed here; two components is the shape of the number without
 * the wall of digits behind it.
 */
function duration(us) {
  if (!isFinite(us)) return '';
  const sign = us < 0 ? '-' : '';
  let n = Math.round(Math.abs(us));
  if (n === 0) return '0';
  const units = [['d', 86400000000], ['h', 3600000000], ['m', 60000000],
    ['s', 1000000], ['ms', 1000], ['µs', 1]];
  let start = units.findIndex(([, size]) => n >= size);
  if (start === -1) start = units.length - 1;
  const parts = [];
  for (let i = start; i < units.length && parts.length < 2; i++) {
    const v = Math.floor(n / units[i][1]);
    n -= v * units[i][1];
    if (v > 0) parts.push(v + units[i][0]);
  }
  return sign + parts.join(' ');
}

/**
 * The chart, as a file.
 *
 * Nothing here is a download: a webview cannot write one, and the host has
 * neither a canvas nor a theme to draw with — so the page rasterizes exactly
 * what is on screen and hands the bytes over, and the host only picks the path.
 *
 * A serialized <svg> carries none of the page's stylesheet and none of the
 * theme's variables with it, so every element in the clone is given the
 * *computed* value of the handful of properties that actually paint something.
 * That is also why the policy at the top of this document allows img-src data:
 * — loading the drawing as an image is the only way it reaches a canvas.
 */
const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size', 'font-weight',
  'text-anchor', 'opacity'];

function paint(live, copy) {
  const computed = getComputedStyle(live);
  copy.setAttribute('style',
    PAINT.map((name) => name + ':' + computed.getPropertyValue(name)).join(';'));
  // A deep clone has the same children in the same order, so the walk pairs up.
  for (let i = 0; i < live.children.length; i++) paint(live.children[i], copy.children[i]);
}

/**
 * The legend, drawn into the export. On screen it is HTML above the plot; in a
 * PNG there is no HTML, and six unlabelled colours are a puzzle rather than a
 * chart. Widths are estimated from the name length because measuring text means
 * laying it out, and an estimate that is wide enough only ever wraps early.
 */
function legendInto(copy, width, bottom) {
  const swatches = Array.from(document.querySelectorAll('#legend i'));
  if (!swatches.length) return bottom;
  const face = getComputedStyle($('legend').firstElementChild);
  let x = 58;
  let y = bottom + 22;
  swatches.forEach((swatch, i) => {
    const name = state.seriesNames[i] || '';
    const span = 32 + name.length * 6.4;
    if (x > 58 && x + span > width - 12) { x = 58; y += 18; }
    const dot = svg('circle', { cx: x + 5, cy: y - 4, r: 4.5 });
    dot.setAttribute('style', 'fill:' + getComputedStyle(swatch).backgroundColor);
    copy.appendChild(dot);
    const caption = svg('text', { x: x + 17, y });
    caption.setAttribute('style',
      'fill:' + face.color + ';font-size:12px;font-family:' + face.fontFamily);
    caption.textContent = name;
    copy.appendChild(caption);
    x += span;
  });
  return y + 10;
}

function save() {
  const source = $('svg');
  const box = (source.getAttribute('viewBox') || '').split(' ').map(Number);
  if (box.length !== 4 || !isFinite(box[2]) || !isFinite(box[3])) return;

  const copy = source.cloneNode(true);
  paint(source, copy);
  // The hovers are the panel's, not the picture's.
  for (const title of copy.querySelectorAll('title')) title.remove();
  const height = legendInto(copy, box[2], box[3]);
  copy.setAttribute('xmlns', NS);
  copy.setAttribute('viewBox', '0 0 ' + box[2] + ' ' + height);
  copy.setAttribute('width', box[2]);
  copy.setAttribute('height', height);

  // Twice the drawing's own coordinates: the viewBox is an aspect ratio, and a
  // chart pasted into anything is read at whatever width that thing gives it.
  const scale = 2;
  $('save').disabled = true;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = box[2] * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    // The page's own background first: a dark theme's marks on the transparency
    // a PNG would otherwise keep are a dark theme's marks on white.
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    done(canvas.toDataURL('image/png').split(',')[1]);
  };
  image.onerror = () => done(undefined);
  image.src = 'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(new XMLSerializer().serializeToString(copy));
}

/** Bytes to the host, or nothing and let it say so. Either way the button comes back. */
function done(png) {
  $('save').disabled = !state || !state.points.length;
  vscode.postMessage({ type: 'export', png });
}

$('save').appendChild(icon(SAVE_ICON));
$('save').addEventListener('click', save);

for (const id of ['x', 'y', 'agg', 'grain']) {
  $(id).addEventListener('change', (event) => vscode.postMessage({ [id]: event.target.value }));
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
