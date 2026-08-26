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
  .origin{
    font-family:var(--vscode-editor-font-family);font-size:.74rem;
    color:var(--vscode-descriptionForeground);margin:.3rem 0 0;
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
  thead th{
    position:sticky;top:0;z-index:2;background:var(--vscode-editor-background);
    font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;
    color:var(--vscode-descriptionForeground);
    padding-top:.5rem;padding-bottom:.4rem;
    box-shadow:inset 0 -1px var(--vscode-panel-border);
  }
  tbody tr:hover td{background:var(--vscode-list-hoverBackground)}
  td.dtype,td.num,td.value{font-family:var(--vscode-editor-font-family)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.dtype{color:var(--vscode-symbolIcon-typeParameterForeground)}
  .none{opacity:.5}
`;

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
