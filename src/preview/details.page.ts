import * as path from 'node:path';
import type { Column } from '../core/types.js';
import type { ResolvedFrame } from '../api.js';
import { dtypeClass, escape, fmt, frameFacts, frameNotes, PANEL_CSS } from './facts.js';

/**
 * The whole page, as a string. Pure — no vscode, no I/O — so what it says about
 * a frame can be tested without an editor around it.
 */
export function renderDetails(frame: ResolvedFrame): string {
  const facts = frameFacts(frame);
  const notes = frameNotes(frame);

  const hasDtype = frame.columns.some((column) => column.dtype);
  const hasStats = frame.columns.some((column) => statOf(column).some((value) => value !== ''));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escape(path.basename(frame.uri))}</title>
<style>${PANEL_CSS}
  td.name{
    font-family:var(--vscode-editor-font-family);
    white-space:normal;word-break:break-word;min-width:8rem;
  }
  td.value{max-width:22rem;overflow:hidden;text-overflow:ellipsis}
  th.right{text-align:right}
</style>
</head>
<body>
<div class="head">
<h1>${escape(path.basename(frame.uri))}${
    frame.symbol ? `<span class="symbol">${escape(frame.symbol)}</span>` : ''
  }</h1>
<p class="origin" title="${escape(frame.uri)}">${escape(frame.uri)}</p>
<ul class="facts">${facts.map((fact) => `<li>${escape(fact)}</li>`).join('')}</ul>
${notes.map((note) => `<p class="note">${note}</p>`).join('\n')}
</div>
<div class="scroller">
<table>
<thead><tr><th>Column</th>${hasDtype ? '<th>Type</th>' : ''}${
    hasStats ? '<th class="right">Nulls</th><th>Min</th><th>Max</th>' : ''
  }</tr></thead>
<tbody>
${frame.columns.map((column) => row(column, hasDtype, hasStats)).join('\n')}
</tbody>
</table>
</div>
</body>
</html>`;
}

function row(column: Column, hasDtype: boolean, hasStats: boolean): string {
  const [nulls, min, max] = statOf(column);
  const cells = [`<td class="name">${escape(column.name)}</td>`];
  if (hasDtype) {
    cells.push(`<td class="dtype ${dtypeClass(column.dtype)}">${escape(column.dtype)}</td>`);
  }
  if (hasStats) {
    cells.push(`<td class="num">${cell(nulls)}</td>`);
    cells.push(`<td class="value">${cell(min)}</td>`);
    cells.push(`<td class="value">${cell(max)}</td>`);
  }
  return `<tr>${cells.join('')}</tr>`;
}

/**
 * Null count, min and max as they will be printed. A statistic the file did not
 * record is an empty string rather than a zero: "no nulls" and "the writer did
 * not say" are different answers, and only one of them is a fact.
 */
function statOf(column: Column): [string, string, string] {
  const stats = column.stats;
  return [
    stats?.nullCount === undefined ? '' : fmt(stats.nullCount),
    stats?.min ?? '',
    stats?.max ?? ''
  ];
}

function cell(value: string): string {
  return value === '' ? '<span class="none">—</span>' : escape(value);
}



