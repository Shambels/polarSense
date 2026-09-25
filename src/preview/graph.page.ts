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
  /* A split bar takes its series colour as a fill; the rules above only set
     the stroke, which a rect does not draw. */
  .mark.s0{fill:var(--vscode-charts-blue)}   .mark.s1{fill:var(--vscode-charts-orange)}
  .mark.s2{fill:var(--vscode-charts-green)}  .mark.s3{fill:var(--vscode-charts-purple)}
  .mark.s4{fill:var(--vscode-charts-red)}    .mark.s5{fill:var(--vscode-charts-yellow)}
  /* The hovered slot lifts with an outline in the text colour rather than a
     lighter fill: a lighter orange is a different orange, an outline is not. */
  .mark.hot{stroke:var(--vscode-foreground);stroke-width:1.5;stroke-opacity:.9}
  .guide{stroke:var(--vscode-foreground);stroke-width:1;stroke-opacity:.35;pointer-events:none}
  .ring{fill:var(--vscode-editor-background);stroke-width:2;pointer-events:none}
  .ring:not([class*=" s"]){stroke:var(--vscode-charts-blue)}
  #svg:focus{outline:none}
  #svg:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
  /* The hover readout. Values lead and names follow: the reader already knows
     which line they pointed at and wants the number on it. */
  .tip{
    position:fixed;z-index:10;pointer-events:none;max-width:22rem;
    background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background));
    color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));
    border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,transparent));
    border-radius:4px;padding:.4rem .55rem;font-size:.78rem;line-height:1.45;
    box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.25));
  }
  .tip[hidden]{display:none}
  .tip .th{display:flex;gap:.45rem;align-items:baseline;margin-bottom:.15rem}
  .tip .k,.tip .muted{color:var(--vscode-descriptionForeground)}
  .tip .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
  .tip .row{display:flex;gap:.45rem;align-items:baseline;white-space:nowrap}
  .tip .row b{font-variant-numeric:tabular-nums;font-weight:600}
  .tip .row.on b{text-decoration:underline;text-underline-offset:2px}
  .tip .row .name{overflow:hidden;text-overflow:ellipsis}
  /* A short stroke of the series colour keys the row: a filled box would be a
     bar's worth of ink doing a label's job. */
  .tip .key{width:.8rem;height:2px;border-radius:1px;flex:none;align-self:center}
  .tip .key.s0{background:var(--vscode-charts-blue)}   .tip .key.s1{background:var(--vscode-charts-orange)}
  .tip .key.s2{background:var(--vscode-charts-green)}  .tip .key.s3{background:var(--vscode-charts-purple)}
  .tip .key.s4{background:var(--vscode-charts-red)}    .tip .key.s5{background:var(--vscode-charts-yellow)}
  /* The per-group control: one button, one menu, two lists in it — what to
     measure, and what to split by. A select can hold only one choice, and these
     are two choices that stand together. */
  .menuwrap{position:relative;display:inline-block}
  .menubtn{
    font-family:inherit;font-size:.78rem;color:var(--vscode-dropdown-foreground);
    background:var(--vscode-dropdown-background);cursor:pointer;
    border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border,transparent));
    border-radius:5px;padding:.26rem .4rem;max-width:16rem;
    display:inline-flex;align-items:center;gap:.35rem;
  }
  .menubtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .menubtn svg{width:10px;height:10px;fill:currentColor;flex:none}
  .menubtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
  .menu{
    position:absolute;z-index:20;top:calc(100% + 3px);left:0;min-width:11rem;
    max-height:60vh;overflow:auto;padding:.25rem 0;
    background:var(--vscode-menu-background,var(--vscode-dropdown-background));
    color:var(--vscode-menu-foreground,var(--vscode-dropdown-foreground));
    border:1px solid var(--vscode-menu-border,var(--vscode-dropdown-border,transparent));
    border-radius:5px;box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.25));
  }
  .menu[hidden]{display:none}
  .menu .mh{
    font-size:.66rem;text-transform:uppercase;letter-spacing:.09em;
    color:var(--vscode-descriptionForeground);padding:.35rem .7rem .2rem;
  }
  .menu .mh+.mi{margin-top:0}
  .menu hr{border:0;border-top:1px solid var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:.25rem 0}
  .menu .mi{
    display:flex;align-items:baseline;gap:.5rem;width:100%;text-align:left;
    font-family:inherit;font-size:.8rem;color:inherit;background:none;border:0;
    padding:.22rem .7rem .22rem 1.6rem;cursor:pointer;position:relative;
  }
  .menu .mi:hover,.menu .mi:focus{
    background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));
    color:var(--vscode-menu-selectionForeground,inherit);outline:none;
  }
  .menu .mi[aria-checked="true"]::before{content:"✓";position:absolute;left:.6rem;font-weight:700}
  .menu .mi .dt{margin-left:auto;padding-left:1rem;font-size:.72rem;opacity:.7;
    font-family:var(--vscode-editor-font-family)}
  .legend{display:flex;flex-wrap:wrap;gap:.15rem .7rem;margin:.45rem 0 0;font-size:.74rem}
  .legend span{display:inline-flex;align-items:center;gap:.3rem;color:var(--vscode-descriptionForeground)}
  .legend i{width:.6rem;height:.6rem;border-radius:50%;display:inline-block}
  .legend i.s0{background:var(--vscode-charts-blue)}
  .legend i.s1{background:var(--vscode-charts-orange)}
  .legend i.s2{background:var(--vscode-charts-green)}
  .legend i.s3{background:var(--vscode-charts-purple)}
  .legend i.s4{background:var(--vscode-charts-red)}
  .legend i.s5{background:var(--vscode-charts-yellow)}
  /* The key mirrors the mark: a stroke for a line, a block for a bar. */
  .legend[data-kind="line"] i{width:.9rem;height:2px;border-radius:1px}
  .legend[data-kind="bar"] i,.legend[data-kind="histogram"] i{border-radius:2px}
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
    <span class="pick" id="aggpick">
      <span class="cap" id="aggcap">per group</span>
      <span class="menuwrap">
        <button type="button" id="agg" class="menubtn" aria-haspopup="menu"
          aria-expanded="false" aria-controls="aggmenu" aria-labelledby="aggcap agg"></button>
        <div id="aggmenu" class="menu" role="menu" aria-labelledby="aggcap" hidden></div>
      </span>
    </span>
    <span class="pick right">
      <span class="kinds" id="kind" role="radiogroup" aria-labelledby="kindcap"></span>
      <button type="button" id="save" class="tool" disabled
        title="Save chart as PNG" aria-label="Save chart as PNG"></button>
    </span>
  </div>
  <div class="legend" id="legend"></div>
</div>
<div class="plot"><svg id="svg" tabindex="0" role="img"></svg></div>
<div class="tip" id="tip" role="tooltip" hidden></div>
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

/** The chevron on the per-group button: it opens something, and says so. */
const CHEVRON = [['polygon', { points: '2,5 14,5 8,11.5' }]];

/**
 * The per-group control: a button that says what is chosen, and a menu with
 * the two lists that choice is made from — how each group is measured, and
 * which column splits the chart into a line, bar or colour per value.
 */
function menu() {
  // A redraw replaces the entries, and with them whatever had focus: an open
  // menu is put away first, with focus back on its button, rather than left
  // open with no entry to move from.
  if (!$('aggmenu').hidden) closeMenu($('aggmenu').contains(document.activeElement));
  const aggs = state.aggs;
  const splits = state.splits || [];
  $('aggpick').hidden = !aggs.length && !splits.length;
  // Where there is nothing to measure it is only a split, and is called one.
  $('aggcap').textContent = aggs.length ? 'per group' : 'split';

  const chosen = [];
  if (aggs.length) chosen.push(state.agg || aggs[0]);
  if (state.split) chosen.push('by ' + state.split);
  const face = $('agg');
  face.replaceChildren(text('span', chosen.join(' · ') || 'none'), icon(CHEVRON));
  face.title = chosen.length ? chosen.join(' · ') : 'no split';

  const items = [];
  const item = (label, detail, checked, message) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'mi';
    node.setAttribute('role', 'menuitemradio');
    node.setAttribute('aria-checked', String(checked));
    node.tabIndex = -1;
    node.appendChild(text('span', label));
    if (detail) node.appendChild(text('span', detail, 'dt'));
    node.addEventListener('click', () => { closeMenu(true); vscode.postMessage(message); });
    return node;
  };
  if (aggs.length) {
    items.push(text('div', 'Aggregate', 'mh'));
    for (const agg of aggs) items.push(item(agg, '', agg === state.agg, { agg }));
  }
  if (splits.length) {
    if (aggs.length) items.push(document.createElement('hr'));
    items.push(text('div', 'Split by', 'mh'));
    items.push(item('none', '', !state.split, { split: '' }));
    for (const column of splits) {
      items.push(item(column.name, column.dtype, column.name === state.split, { split: column.name }));
    }
  }
  $('aggmenu').replaceChildren(...items);
}

function entries() {
  return Array.from($('aggmenu').querySelectorAll('.mi'));
}

function openMenu() {
  const list = $('aggmenu');
  if (!list.hidden) return;
  hideTip();
  list.hidden = false;
  $('agg').setAttribute('aria-expanded', 'true');
  const all = entries();
  (all.find((node) => node.getAttribute('aria-checked') === 'true') || all[0])?.focus();
}

function closeMenu(refocus) {
  const list = $('aggmenu');
  if (list.hidden) return;
  list.hidden = true;
  $('agg').setAttribute('aria-expanded', 'false');
  if (refocus) $('agg').focus();
}

$('agg').addEventListener('click', () => ($('aggmenu').hidden ? openMenu() : closeMenu(false)));
$('agg').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
});
$('aggmenu').addEventListener('keydown', (event) => {
  const all = entries();
  const at = all.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { event.preventDefault(); all[(at + 1) % all.length]?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
  else if (event.key === 'Home') { event.preventDefault(); all[0]?.focus(); }
  else if (event.key === 'End') { event.preventDefault(); all[all.length - 1]?.focus(); }
  else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  else if (event.key === 'Tab') closeMenu(false);
});
// A click anywhere else puts the menu away, as every menu does.
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest || !event.target.closest('.menuwrap')) closeMenu(false);
});

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
  // Only grouped rows have anything to measure, and only a chart whose y is
  // not already a label can take a split: the control shows the lists that mean
  // something here, and is not on screen at all where neither does.
  menu();
  // Only a date can be grouped into periods, and the first option is not one:
  // a timestamp left alone is a different chart, not a missing choice.
  $('grain').replaceChildren(
    option('', 'exact', !state.grain),
    ...state.grains.map((grain) => option(grain, grain, grain === state.grain))
  );
  for (const node of document.querySelectorAll('.grainrow')) node.hidden = !state.grains.length;

  // The legend is the only thing that says which line is which, so it is drawn
  // from the same order the colours are taken in.
  $('legend').dataset.kind = state.kind;
  $('legend').replaceChildren(...state.seriesNames.map((name, i) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = 's' + (i % 6);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(name));
    return item;
  }));

  const nothing = !state.points.length;
  hideTip();
  hover = null;
  $('svg').replaceChildren();
  // What the chart is, for a screen reader, and how to read its values.
  $('svg').setAttribute('aria-label', state.kind + ' of ' + (state.yLabel || 'rows') + ' by ' +
    state.xLabel + (state.split ? ', split by ' + state.split : '') +
    '. Arrow keys read the values.');
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
  // One slot per x value, and one bar per series inside it — side by side, not
  // stacked, because a stack of means adds up to nothing. Unsplit, a slot holds
  // one bar and this is the chart it always was.
  const series = state.seriesNames;
  const slots = [];
  const byX = new Map();
  for (const point of state.points) {
    let slot = byX.get(point.x);
    if (!slot) { slot = { x: point.x, label: point.label, points: [], rects: [] }; byX.set(point.x, slot); slots.push(slot); }
    slot.points.push(point);
  }
  slots.sort((a, b) => a.x - b.x);

  const n = slots.length;
  const slot = width / n;
  const pad = state.kind === 'histogram' ? Math.min(1, slot * 0.08) : Math.min(8, slot * 0.2);
  const zero = py(0);
  const k = series.length || 1;
  const inner = Math.max(1, slot - pad * 2);
  // A hairline of background between neighbours in a slot, so two bars of
  // similar colour still read as two.
  const gap = k > 1 ? Math.min(2, (inner / k) * 0.2) : 0;
  const each = Math.max(0.5, (inner - gap * (k - 1)) / k);

  const stops = [];
  slots.forEach((entry, i) => {
    for (const point of entry.points) {
      const j = series.length ? Math.max(0, series.indexOf(point.series)) : 0;
      // A split histogram sends its empty bins so the slots line up; drawn, an
      // empty bin is a sliver on the baseline that reads as a value. The
      // readout still says 0 for it. A bar's 0 is a measurement and is drawn.
      if (series.length && state.kind === 'histogram' && point.y === 0) continue;
      const y = py(point.y);
      const rect = svg('rect', {
        x: left + slot * i + pad + j * (each + gap),
        y: Math.min(y, zero),
        width: each,
        height: Math.max(1, Math.abs(zero - y))
      }, 'mark' + (series.length ? ' s' + (j % 6) : ''));
      node.appendChild(rect);
      entry.rects.push(rect);
    }
    stops.push({
      cx: left + slot * (i + 0.5),
      cy: py(Math.max(...entry.points.map((point) => point.y))),
      x0: left + slot * i,
      x1: left + slot * (i + 1),
      label: entry.label,
      points: entry.points,
      marks: entry.rects
    });
  });
  hover = { mode: 'slots', stops, left, top, width, height };

  if (state.xNumeric) { ticks(node, left, top, width, height); return; }

  // A caption per bar where they fit, every other one where they do not, and
  // slanted throughout: a category is a word, and a word does not fit under a
  // twentieth of a panel.
  const step = n > 16 ? 2 : 1;
  slots.forEach((entry, i) => {
    if (i % step) return;
    const x = left + slot * (i + 0.5);
    const caption = label(0, 0, entry.label, 'end');
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
    // can see that a run of dates has gaps in it. A series of one point has no
    // line to be seen by, so its marker is drawn at a size that can be.
    const radius = state.kind !== 'line' ? 2.6 : points.length === 1 ? 3.5 : 1.8;
    for (const point of points) {
      node.appendChild(svg('circle', { cx: px(point.x), cy: py(point.y), r: radius }, 'dot' + colour));
    }
  });

  ticks(node, left, top, width, height);

  // What the pointer snaps to. A line is read at an x — every series at once,
  // under a hairline — because nobody can aim at a two-pixel stroke. A scatter
  // is read a point at a time, the nearest one, since its rows share no x.
  const at = (point) => ({ point, cx: px(point.x), cy: py(point.y) });
  if (state.kind === 'line') {
    const byX = new Map();
    for (const point of state.points) {
      const stop = byX.get(point.x) || { cx: px(point.x), label: point.label, points: [], x: point.x };
      stop.points.push(point);
      byX.set(point.x, stop);
    }
    const stops = [...byX.values()].sort((a, b) => a.x - b.x);
    for (const stop of stops) stop.cy = Math.min(...stop.points.map((point) => py(point.y)));
    hover = { mode: 'x', stops, left, top, width, height, py };
  } else {
    const stops = state.points.map(at)
      .map(({ point, cx, cy }) => ({ cx, cy, label: point.label, points: [point] }))
      .sort((a, b) => a.cx - b.cx || a.cy - b.cy);
    hover = { mode: 'nearest', stops, left, top, width, height, py };
  }
}

/** The host's ticks, placed. It formats them because it is the side that knows a date from a number. */
function ticks(node, left, top, width, height) {
  const marks = state.ticks;
  if (!marks.length) return;
  const domain = state.domain || extent(marks.map((tick) => tick.x));
  const span = domain[1] - domain[0] || 1;
  marks.forEach((tick, i) => {
    const x = left + ((tick.x - domain[0]) / span) * width;
    // The last label hangs back from the edge rather than past it: centred on
    // the axis end, a timestamp runs off the panel by half its width.
    const end = i === marks.length - 1 && marks.length > 1;
    node.appendChild(label(x, top + height + 14, tick.label, end ? 'end' : 'mid'));
  });
}

function extent(numbers) {
  return [Math.min(...numbers), Math.max(...numbers)];
}

/**
 * The hover layer. Built after each draw from what was drawn — the slots of a
 * bar chart, the x positions of a line, the points of a scatter — so the page
 * never has to ask the host for anything to answer a pointer.
 */
let hover = null;
let current = -1;

/** A pointer position in the drawing's own coordinates, whatever width it is shown at. */
function toView(event) {
  const node = $('svg');
  const rect = node.getBoundingClientRect();
  const box = (node.getAttribute('viewBox') || '').split(' ').map(Number);
  if (!rect.width || box.length !== 4) return null;
  return {
    x: (event.clientX - rect.left) * (box[2] / rect.width),
    y: (event.clientY - rect.top) * (box[3] / rect.height),
    scale: box[2] / rect.width
  };
}

/** Which stop the pointer is on, or -1 for none. */
function findStop(at) {
  if (!hover || !hover.stops.length || !at) return -1;
  const { stops, left, top, width, height } = hover;
  // A little slack around the plot, so the first and last marks are not only
  // reachable from exactly inside the axis.
  const slack = 12 * at.scale;
  if (at.x < left - slack || at.x > left + width + slack ||
      at.y < top - slack || at.y > top + height + slack) return -1;
  if (hover.mode === 'slots') {
    // The whole slot is the target, not the painted bar: a short bar is still
    // a full-height column of pointer.
    return stops.findIndex((stop) => at.x >= stop.x0 && at.x < stop.x1);
  }
  let best = -1;
  let distance = Infinity;
  stops.forEach((stop, i) => {
    const d = hover.mode === 'x'
      ? Math.abs(stop.cx - at.x)
      : Math.hypot(stop.cx - at.x, stop.cy - at.y);
    if (d < distance) { distance = d; best = i; }
  });
  // A scatter point answers only when the pointer is near it — 24px of target
  // around a dot a few pixels wide, and nothing in the empty space between.
  return hover.mode === 'nearest' && distance > 24 * at.scale ? -1 : best;
}

function showTip(index, client) {
  if (!hover || index < 0 || index >= hover.stops.length) { hideTip(); return; }
  const stop = hover.stops[index];
  current = index;
  clearHot();

  const node = $('svg');
  if (hover.mode === 'slots') {
    for (const mark of stop.marks) mark.classList.add('hot');
  } else {
    if (hover.mode === 'x') {
      node.appendChild(svg('line', { x1: stop.cx, y1: hover.top, x2: stop.cx,
        y2: hover.top + hover.height }, 'guide hover'));
    }
    for (const point of stop.points) {
      const i = state.seriesNames.indexOf(point.series);
      node.appendChild(svg('circle', { cx: stop.cx, cy: hover.py(point.y), r: 4.5 },
        'ring hover' + (i >= 0 ? ' s' + (i % 6) : '')));
    }
  }

  const tip = $('tip');
  tip.replaceChildren(...readout(stop, client && client.series));
  tip.hidden = false;
  place(tip, client || anchor(stop));
}

function hideTip() {
  current = -1;
  clearHot();
  $('tip').hidden = true;
}

function clearHot() {
  for (const node of document.querySelectorAll('#svg .hover')) node.remove();
  for (const node of document.querySelectorAll('#svg .hot')) node.classList.remove('hot');
}

/** Where a stop is on screen, for a readout opened from the keyboard. */
function anchor(stop) {
  const node = $('svg');
  const rect = node.getBoundingClientRect();
  const box = (node.getAttribute('viewBox') || '').split(' ').map(Number);
  const scale = rect.width / box[2];
  return { x: rect.left + stop.cx * scale, y: rect.top + stop.cy * scale };
}

/** Beside the pointer, and flipped to the other side of it rather than off the panel. */
function place(tip, at) {
  const gap = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = at.x + gap;
  let y = at.y + gap;
  if (x + w > window.innerWidth - 4) x = Math.max(4, at.x - gap - w);
  if (y + h > window.innerHeight - 4) y = Math.max(4, at.y - gap - h);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

/**
 * The readout: where on x, then one row per value there — the value in bold,
 * the series it belongs to after it, and how many rows it stands for where it
 * is an aggregate of them. Built from text nodes: a label is data, not markup.
 */
function readout(stop, focus) {
  const nodes = [];
  const head = document.createElement('div');
  head.className = 'th';
  head.appendChild(text('span', state.kind === 'histogram' ? 'range' : state.xLabel, 'k'));
  head.appendChild(text('span', stop.label));
  nodes.push(head);

  const split = state.seriesNames.length > 0;
  // With several series the measure is named once, above them; alone it is
  // named beside its value.
  if (split && state.yLabel) nodes.push(text('div', state.yLabel, 'k'));
  const rows = split
    ? [...stop.points].sort((a, b) =>
        state.seriesNames.indexOf(a.series) - state.seriesNames.indexOf(b.series))
    : stop.points;
  for (const point of rows.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'row' + (focus && point.series === focus ? ' on' : '');
    if (split) {
      const i = state.seriesNames.indexOf(point.series);
      row.appendChild(text('i', '', 'key s' + (i % 6)));
    }
    row.appendChild(text('b', exact(point.y)));
    row.appendChild(text('span', split ? point.series : state.yLabel, 'name muted'));
    // A count is its own row total, so saying it twice would be noise.
    const counted = state.yLabel === 'rows' || state.agg === 'count';
    if (point.n !== undefined && !counted) {
      row.appendChild(text('span', '· ' + number(point.n) + ' row' + (point.n === 1 ? '' : 's'), 'muted'));
    }
    nodes.push(row);
  }
  if (rows.length > 12) nodes.push(text('div', '+' + (rows.length - 12) + ' more', 'muted'));
  return nodes;
}

const svgNode = $('svg');
svgNode.addEventListener('pointermove', (event) => {
  const at = toView(event);
  const index = findStop(at);
  if (index < 0) { hideTip(); return; }
  // Which bar in a slot the pointer is over, so its row can be marked as the one.
  const series = event.target && event.target.classList && event.target.classList.contains('mark')
    ? seriesOf(event.target)
    : undefined;
  showTip(index, { x: event.clientX, y: event.clientY, series });
});
svgNode.addEventListener('pointerleave', hideTip);
svgNode.addEventListener('blur', hideTip);
// The same readout from the keyboard: the chart takes focus, and the arrows
// walk its slots, its x positions, or its points from left to right.
svgNode.addEventListener('keydown', (event) => {
  if (!hover || !hover.stops.length) return;
  const last = hover.stops.length - 1;
  let next = null;
  if (event.key === 'ArrowRight') next = current < 0 ? 0 : Math.min(last, current + 1);
  else if (event.key === 'ArrowLeft') next = current < 0 ? last : Math.max(0, current - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  else if (event.key === 'Escape') { hideTip(); return; }
  if (next === null) return;
  event.preventDefault();
  showTip(next);
});

/** The series a bar belongs to, read off its colour class — the same index the legend uses. */
function seriesOf(mark) {
  const colour = [...mark.classList].find((name) => name.length === 2 && name[0] === 's');
  return colour ? state.seriesNames[Number(colour[1])] : undefined;
}

/**
 * A value as exact as it is: every significant digit a double carries, less
 * the float noise past fifteen — 0.1 + 0.2 reads 0.3 — with the thousands
 * grouped. The axis rounds to four digits because it is a scale; this does not,
 * because the hover is where the number is read.
 */
function exact(value) {
  if (state && state.yDuration) return duration(value, 6);
  if (!isFinite(value)) return String(value);
  return value.toLocaleString('en-US', { maximumSignificantDigits: 15 });
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
function duration(us, most) {
  if (!isFinite(us)) return '';
  const sign = us < 0 ? '-' : '';
  let n = Math.round(Math.abs(us));
  if (n === 0) return '0';
  const units = [['d', 86400000000], ['h', 3600000000], ['m', 60000000],
    ['s', 1000000], ['ms', 1000], ['µs', 1]];
  let start = units.findIndex(([, size]) => n >= size);
  if (start === -1) start = units.length - 1;
  const parts = [];
  for (let i = start; i < units.length && parts.length < (most || 2); i++) {
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
    const key = state.kind === 'line'
      ? svg('rect', { x: x - 1, y: y - 5, width: 12, height: 2.5, rx: 1 })
      : state.kind === 'bar' || state.kind === 'histogram'
        ? svg('rect', { x: x + 0.5, y: y - 8.5, width: 9, height: 9, rx: 2 })
        : svg('circle', { cx: x + 5, cy: y - 4, r: 4.5 });
    key.setAttribute('style', 'fill:' + getComputedStyle(swatch).backgroundColor);
    copy.appendChild(key);
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

  // The hover is the panel's, not the picture's: put it away before the copy.
  hideTip();
  const copy = source.cloneNode(true);
  paint(source, copy);
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

for (const id of ['x', 'y', 'grain']) {
  $(id).addEventListener('change', (event) => vscode.postMessage({ [id]: event.target.value }));
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
