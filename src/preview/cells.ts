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

/**
 * The variable a cell printed, when its last statement is nothing but a name.
 *
 * This is the kernel's second address for a frame that has no file behind it —
 * `_oh[n]` is the first, and misses when the kernel restarted or the cell ended
 * in `display(df)` rather than `df`. Only a bare name is taken: `df.head()` is
 * not `df`, and reading `df` in its place would draw more than the cell printed.
 *
 * A name that is really the tail of a longer statement — the last line of a
 * bracketed call, or after a backslash — is refused rather than guessed at. The
 * bracket count is naive about strings, which only ever errs towards refusing.
 */
export function lastStatementName(source: string): string | undefined {
  const offset = lastStatementOffset(source);
  if (offset === undefined) return undefined;
  // The line the statement starts on, less a trailing comment: anything after
  // it is blanks and comments, which is how the offset was chosen.
  const name = source.slice(offset).split('\n')[0].replace(/#.*$/, '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;

  const before = source.slice(0, offset);
  if (/\\\s*$/.test(before)) return undefined;
  let depth = 0;
  for (const line of before.split('\n')) {
    for (const ch of line.replace(/#.*$/, '')) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
  }
  return depth === 0 ? name : undefined;
}
