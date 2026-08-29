import { newNonce, PANEL_CSS } from './facts.js';

/**
 * The document, once. It holds no data: every value on screen arrives later as a
 * message and is written with `textContent`, which is what makes a column name
 * out of someone's parquet file unable to be anything but text.
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
  /* A header is a control now: clicking it orders the rows by that column. */
  thead th.sortable{cursor:pointer;user-select:none}
  thead th.sortable:hover{color:var(--vscode-textLink-foreground)}
  thead th.sortable:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}
  thead th .arrow{margin-left:.3rem;opacity:.9}
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
  /* The one note you can press. It sits inside the note it belongs to, because
     the sentence is what says what the button will do. */
  .note button{
    display:inline-block;margin-left:.5rem;padding:.2rem .5rem;
    border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
    border-radius:4px;font-size:.78rem;
    background:var(--vscode-editorWidget-background);
  }
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
    <span class="group" id="panels" hidden>
      <button id="details" title="Every column's type and statistics, from the file's own metadata">Details</button>
      <button id="graph" title="Draw the shape of a column (reads rows)">Graph</button>
    </span>
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
  // The sort's note carries the button that widens or re-caps what it read, so
  // the sentence and the thing that changes it are the same box.
  if (state.sortNote) {
    const note = text('p', state.sortNote.text, 'note');
    const button = text('button', state.sortNote.button);
    button.addEventListener('click', () => send({ type: 'sortAll' }));
    note.appendChild(button);
    $('notes').appendChild(note);
  }

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
  // Only the editor's own grid carries them: opened from the palette, the two
  // panels are a keystroke away and would be answering about the cursor anyway.
  $('panels').hidden = !state.panels;

  // Numbers line up under each other or they are not numbers, they are text
  // that happens to be digits. The host already said which family each is.
  const kinds = state.kinds;
  const numeric = state.columns.map((_, i) => kinds[i] === 't-int' || kinds[i] === 't-float');

  const header = document.createElement('tr');
  header.appendChild(text('th', '#', 'index'));
  state.columns.forEach((name, i) => {
    const cell = text('th', name, 'sortable' + (numeric[i] ? ' num' : ''));
    const sorted = state.sort && state.sort.column === name;
    if (sorted) cell.appendChild(text('span', state.sort.desc ? '▼' : '▲', 'arrow'));
    if (state.dtypes[i]) cell.appendChild(text('span', state.dtypes[i], 'dtype ' + kinds[i]));
    // Ascending, descending, then back to the file's own order.
    cell.title = sorted && state.sort.desc
      ? 'Back to the order the file is written in'
      : 'Sort by ' + name + (sorted ? ', descending' : '');
    cell.tabIndex = 0;
    const sort = () => send({ sort: name });
    cell.addEventListener('click', sort);
    cell.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sort(); }
    });
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
$('details').addEventListener('click', () => send({ type: 'details' }));
$('graph').addEventListener('click', () => send({ type: 'graph' }));
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
