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
