/**
 * The two questions the buttons under a notebook output rest on, both answered
 * without running anything: **is this output a frame**, and **which expression
 * printed it**.
 *
 * Neither needs a kernel, which is the whole reason the renderer can carry the
 * buttons at all — the cell's source says which frame it is, and the resolver
 * already knows which file that frame reads. Both are pure string functions so
 * they can be tested without a notebook, an editor or a webview.
 */

/**
 * polars and pandas both write their repr as `<table … class="dataframe">`, and
 * polars puts its shape above it. Matching the table class is what keeps this
 * from claiming every HTML output in the notebook: a matplotlib figure, a
 * `display(HTML(…))` banner and a plotly chart all arrive on the same mime type
 * and none of them is a frame.
 *
 * It stays a look-alike test on purpose. Being sure would mean asking the
 * kernel, and a button offered on something that turns out not to be a frame
 * costs one "no frame here" message — while a button withheld from a real frame
 * is the feature not existing.
 */
const FRAME_TABLE = /<table[^>]*\sclass\s*=\s*["'][^"']*\bdataframe\b/i;

export function looksLikeFrame(html: string): boolean {
  return FRAME_TABLE.test(html);
}

/**
 * Where the cell's last statement begins.
 *
 * A notebook prints the value of the last expression in the cell, so that is the
 * frame the output under it belongs to — and an offset anywhere inside that
 * expression is enough, because `frameAtOffset` walks outward to the widest
 * expression that still resolves. That is why this can be a line scan rather
 * than a parse: it only has to land somewhere in the right statement.
 *
 * Blank lines and comments are skipped from the bottom up, so a cell that ends
 * with `# takes a while` still points at the frame above it. Returns undefined
 * for a cell holding nothing but blanks and comments, which has no output to
 * put a button under anyway.
 */
export function lastStatementOffset(source: string): number | undefined {
  const lines = source.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    // The first non-space character: an offset on the indentation belongs to
    // the block, not to the statement inside it.
    return starts[i] + (line.length - line.trimStart().length);
  }
  return undefined;
}
