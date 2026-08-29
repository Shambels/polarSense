import type { ResolvedFrame } from '../api.js';

/**
 * What the panels say about a frame before they say anything about its columns.
 *
 * Both panels show the same file and have to admit the same thing about it, so
 * they say it in the same words: the header names the file and its shape, and a
 * note names the gap between the file and the frame at your cursor.
 */

/** The file's shape, in the order a header reads best. */
export function frameFacts(frame: ResolvedFrame): string[] {
  const facts = [
    frame.rowCount === undefined
      ? undefined
      : `${fmt(frame.rowCount)} row${frame.rowCount === 1 ? '' : 's'}`,
    `${fmt(frame.columns.length)} column${frame.columns.length === 1 ? '' : 's'}`,
    frame.sizeBytes === undefined ? undefined : bytes(frame.sizeBytes),
    frame.rowGroups === undefined
      ? undefined
      : `${fmt(frame.rowGroups)} row group${frame.rowGroups === 1 ? '' : 's'}`,
    frame.compression
  ].filter((fact): fact is string => !!fact);
  if (frame.transformed) facts.push('transforms not applied');
  return facts;
}

/**
 * The sentences under the header. The frame at the cursor may be a filter or a
 * select away from the file, and every number above describes the file — showing
 * them under the frame's name without saying so is the one way a panel built on
 * a static resolver can be quietly wrong.
 */
export function frameNotes(frame: ResolvedFrame): string[] {
  return [
    frame.transformed
      ? 'The frame here has transforms applied — a filter, a select, a join. ' +
        'This panel shows the file behind it, so the rows are the file’s rows in ' +
        'the file’s order, and nothing here applies the transforms.'
      : undefined,
    frame.certain
      ? undefined
      : 'Part of the chain could not be read statically, so this column list is ' +
        'approximate — it may hold columns the frame no longer has.'
  ].filter((note): note is string => !!note);
}

/** What a sorted page knows about how much of the file its order covers. */
export interface SortWindow {
  /** Rows the order was actually computed over. */
  sortedRows: number;
  /** Rows in the file, when the format records one. CSV records none. */
  total?: number;
  /** Columns the sort had to decode per row — rows × this is what it held. */
  width: number;
  /** The most rows it could hold at that width, whatever the cap says. */
  ceiling: number;
  /** The row cap from settings, which is the way back from having lifted it. */
  cap: number;
  /** Whether the cap is currently lifted for this panel. */
  all: boolean;
  /** The rows came out of a bounded prefix rather than the whole file. */
  prefix: boolean;
}

/**
 * The sentence about a sorted page, and the button that changes it.
 *
 * Sorting is the one thing here that reads past the page it draws, so it is the
 * one place a panel can quietly describe a tenth of a file as if it were the
 * file. This decides which of the three true things to say — you are seeing a
 * window, you are seeing the whole file, or the window is all this reader can
 * reach — and offers the button only where it could actually be honoured.
 *
 * Pure, because which of those is true is arithmetic and the wording is the
 * feature: both are worth testing without a webview.
 */
export function sortNote(w: SortWindow): { text: string; button?: string } | undefined {
  const seen = `Sorted over the first ${fmt(w.sortedRows)} of ${fmt(w.total ?? 0)} rows — ` +
    'the top of that window, not of the file.';

  if (w.total === undefined) {
    // A CSV: the prefix is not a cap that can be lifted, it is the end of what
    // this reader can reach, so there is nothing to offer.
    return w.prefix
      ? {
          text: `Sorted over the ${fmt(w.sortedRows)} rows inside that prefix, which is ` +
            'all of the file this reader can reach.'
        }
      : undefined;
  }

  if (w.sortedRows < w.total) {
    // Ordering the file means holding every drawn cell of it at once. Past a few
    // million of those the read does not get slow, it dies — so where that is
    // the answer, say it, and say the one thing that changes it.
    return w.ceiling >= w.total
      ? {
          text: `${seen} Ordering all of them reads every row of the columns on screen.`,
          button: `Sort all ${fmt(w.total)} rows`
        }
      : {
          text: `${seen} All ${fmt(w.total)} would mean holding ` +
            `${fmt(w.total * w.width)} cells at once, which is past what this panel ` +
            'can hold — stepping the column window narrower is what raises the rows ' +
            'it can order.'
        };
  }

  // The whole file was ordered. Worth saying only where the cap would otherwise
  // have stopped it, because that is the state you can leave.
  return w.all && w.total > w.cap
    ? {
        text: `Sorted over all ${fmt(w.total)} rows: every one of them was read to ` +
          'order this page.',
        button: `Back to the first ${fmt(w.cap)}`
      }
    : undefined;
}

/**
 * A dtype reduced to the handful of families worth colouring differently.
 *
 * Reading a wide table is mostly asking "what kind of thing is this column",
 * and a colour answers that faster than the name does. The families are the
 * ones that behave differently — text, whole numbers, fractions, flags, points
 * in time, things with a shape inside them — not every dtype polars has.
 *
 * The host computes it and sends it: the grid draws what it is given, so there
 * is one copy of this rule rather than one here and one in the webview.
 */
export function dtypeClass(dtype: string | undefined): string {
  const d = (dtype ?? '').toLowerCase();
  if (!d) return 't-other';
  if (/^(bool|boolean)/.test(d)) return 't-bool';
  if (/^(i|u)\d/.test(d) || /^(int|uint|long|short)/.test(d)) return 't-int';
  if (/^f\d/.test(d) || /^(float|double|decimal)/.test(d)) return 't-float';
  if (/^(date|time|duration|timestamp)/.test(d)) return 't-temporal';
  if (/^(list|array|struct|object|binary|map)/.test(d)) return 't-nested';
  if (/^(str|utf8|string|cat|enum|char)/.test(d)) return 't-str';
  return 't-other';
}

/**
 * The chrome both panels wear: page, header, facts line, notes, and the grid
 * they each fill differently. It lives here because they sit side by side and
 * two copies of it drift — the details panel is the data panel with a different
 * table in it, and it should look like it.
 *
 * Every colour is a VS Code theme variable. A panel that picks its own greys is
 * a panel that is wrong in half the themes people use.
 */
export const PANEL_CSS = `
  *{box-sizing:border-box}
  body{
    font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
    color:var(--vscode-foreground);background:var(--vscode-editor-background);
    margin:0;padding:0;height:100vh;display:flex;flex-direction:column;
  }
  .head{padding:1rem 1.15rem .75rem;flex:none}
  h1{
    font-size:1rem;font-weight:600;letter-spacing:-.01em;margin:0;
    display:flex;align-items:baseline;gap:.45rem;flex-wrap:wrap;
  }
  .symbol{
    font-family:var(--vscode-editor-font-family);font-size:.82rem;font-weight:400;
    color:var(--vscode-descriptionForeground);
  }
  /* The path is a different kind of fact from the numbers under it — where the
     data is, not what is in it — so it is a different colour from them. */
  .origin{
    font-family:var(--vscode-editor-font-family);font-size:.74rem;
    color:var(--vscode-textPreformat-foreground,var(--vscode-textLink-foreground));
    opacity:.85;margin:.3rem 0 0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .facts{
    display:flex;flex-wrap:wrap;list-style:none;padding:0;margin:.5rem 0 0;
    font-size:.78rem;color:var(--vscode-descriptionForeground);
  }
  .facts li+li::before{content:"·";margin:0 .45rem;opacity:.55}
  .note{
    border-left:2px solid var(--vscode-textLink-foreground);
    background:var(--vscode-textBlockQuote-background);
    border-radius:0 4px 4px 0;line-height:1.5;
    padding:.5rem .75rem;margin:.7rem 0 0;font-size:.82rem;
  }
  .scroller{
    flex:1;min-height:0;overflow:auto;
    border-top:1px solid var(--vscode-panel-border);
  }
  /* Columns as wide as what is in them, and the last one absorbing the slack:
     a grid whose every column is stretched to fill the panel is a grid you
     read across a gap. */
  table{border-collapse:separate;border-spacing:0;font-size:.82rem;width:max-content;min-width:100%}
  th,td{text-align:left;padding:.3rem .7rem;white-space:nowrap;vertical-align:top}
  th:last-child,td:last-child{width:100%}
  tbody td{border-bottom:1px solid var(--vscode-panel-border)}
  /* The header and the row index are chrome, not data: a background of their
     own is what stops a wide table reading as one undifferentiated sheet. */
  thead th{
    position:sticky;top:0;z-index:2;
    background:var(--vscode-editorWidget-background,var(--vscode-editor-background));
    font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;
    color:var(--vscode-foreground);
    padding-top:.5rem;padding-bottom:.4rem;
    box-shadow:inset 0 -1px var(--vscode-panel-border);
  }
  tbody tr:hover td{background:var(--vscode-list-hoverBackground)}
  td.dtype,td.num,td.value{font-family:var(--vscode-editor-font-family)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.dtype{color:var(--vscode-symbolIcon-typeParameterForeground)}
  .none{opacity:.5}
  /* The chart colours are the theme's own, so they stay legible in themes
     nobody here has seen. A dtype we do not recognise keeps the plain one. */
  .dtype.t-str{color:var(--vscode-charts-blue)}
  .dtype.t-int{color:var(--vscode-charts-green)}
  .dtype.t-float{color:var(--vscode-charts-purple)}
  .dtype.t-bool{color:var(--vscode-charts-orange)}
  .dtype.t-temporal{color:var(--vscode-charts-yellow)}
  .dtype.t-nested{color:var(--vscode-charts-red)}
`;

/**
 * A one-off nonce for a page's own script tag. The panels load nothing from
 * anywhere, so this exists to let the page's inline script run and nothing else.
 */
export function newNonce(): string {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
  ).join('');
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Powers of 1024, one decimal, because a file size is a glance not a measurement. */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

/**
 * Every column name, dtype and value on these panels came out of a data file.
 * Scripts are off on the details panel and sandboxed on the table, but an
 * unescaped `<` would still wreck the markup it lands in — and a file is not
 * something to take markup from.
 */
export function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
