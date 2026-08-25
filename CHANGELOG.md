# Changelog

## Unreleased

### Added

- **`pl.col("address").struct.field("␣")` completes the struct's fields.** The
  readers were flattening every schema to top-level names; they keep the tree
  now, for parquet, Delta and Iceberg alike, and a struct inside a struct keeps
  going — `…field("geo").struct.field("␣")` offers what is under `geo`.

  It is the same lookup as anywhere else, just one level down: the frame is found
  the way `pl.col` finds it, and the path says which column of it and which field
  of that. So hover and the unknown-column check came along —
  `.struct.field("citt")` warns and offers `city`. A path the schema cannot
  follow means silence, not an empty list: "no idea" and "this struct has no
  fields" are different answers.

  A struct field also finds its own statistics, because the parquet footer keys
  them by the full path and the reader now looks them up that way. `df.unnest("␣")`
  names a top-level struct column too, which was an adjacent gap.

### Fixed

- **`.struct.field("city")` was propagating under the wrong name.** polars names
  the result after the field; the schema evaluator was naming it after the struct
  it came out of, so `df.select(pl.col("address").struct.field("city"))` offered
  `address` downstream.

## 0.3.0

### Added

- **A Delta table whose commits have been vacuumed reads its schema from the
  checkpoint.** The log walk looks for a `metaData` action in `_delta_log/*.json`;
  once those commits are gone, all that is left is `*.checkpoint.parquet`, and
  such a table used to report no columns at all. The fallback reads the
  checkpoint's `metaData` column — through the same hyparquet path the parquet
  reader already uses.

  It runs second on purpose: a JSON commit is always newer than the checkpoint
  beneath it, so the walk keeps the last word and a stale checkpoint can never
  surface. The checkpoint is picked from the directory listing already in hand
  rather than from `_last_checkpoint`, which can be missing or stale without the
  checkpoints themselves being either, and multi-part checkpoints are read in
  order until the schema turns up.

  A checkpoint of a million files still decodes only a handful of rows: the row
  group holding the `metaData` action is found from the footer's own null counts,
  the same statistics the parquet reader reads for hover. Only when a checkpoint
  records no statistics does it fall back to scanning the head of the file.

  This is the one place the extension decompresses a parquet page rather than
  reading a footer, which makes it the one place the compression codec matters.
  Snappy — what Spark and delta-rs write — is understood; a checkpoint written
  with ZSTD or brotli reports nothing, as it did before.

### Changed

- **The schemas a file names are read when it opens**, not when you first ask for
  a column. That read is the one visibly slow moment in the extension: the
  completion list comes back empty and `isIncomplete`, and you have to type
  another character before anything appears. Opening the file, or switching to
  its tab, now does it in the background first.

  The unknown-column check already caused most of this as a side effect. What is
  new is that it happens with that check turned off, on open rather than a pause
  after the first edit, and for every source the file names rather than only the
  ones sitting at a column position — including a frame it imports from another
  module, which is one of its own sources once imports are followed.

  Re-warming is cheap rather than tracked: the parse is cached and a schema
  already read is a cache hit, so this runs on every open and every editor switch
  without bookkeeping to remember what it has done. It reads at most eight
  sources per file, and the trace log says how many the file actually had.

## 0.2.1

### Added

- **Constraint keywords complete.** polars lets a column name be a keyword
  argument — `df.filter(region="EU")`, and the same for `remove` — which makes it
  the one column position in the whole extension that is not inside a string.
  It needed a different way in and nothing else: the same frame, the same schema,
  the same narrowing through whatever transforms came before it. The name is
  inserted with its `=`, since nothing else would be valid there.

  Typo-checking followed for free. `df.filter(regoin="EU")` warns and offers
  `region`, with the same one-click fix as everywhere else, and hovering the
  keyword shows the column's dtype and statistics.

- **A "show schema" command.** The status bar has said `24 cols` since the first
  release and did nothing but open the log. Clicking it now shows the columns —
  name, dtype, and the min, max and null count already read from the file — and
  picking one writes it at the cursor, replacing the half-typed name if you were
  in the middle of one.

  Invoked from the palette with the cursor anywhere, it falls back to the sources
  the file reads: straight in if there is one, a pick between them if there are
  several. It says when the column list is approximate, for the same reasons the
  completion list does. The log is still a command away —
  **PolarSense: Show log**.

## 0.2.0

### Added

- **Column names complete inside SQL strings.** `df.sql("SELECT ␣ FROM self")`,
  `pl.sql("SELECT ␣ FROM df")`, `pl.SQLContext(sales=df).execute(…)` and duckdb's
  `duckdb.sql("SELECT ␣ FROM 'sales.parquet'")` all offer the columns of whichever
  table the statement reads.

  A table reference is resolved four ways, in order: a quoted path or a
  `read_parquet(…)` call is a file; `self` is the frame `.sql(…)` was called on; a
  name registered with `SQLContext(sales=df)` or `.register("sales", df)` is that
  frame; and anything else is looked up as a plain Python name in the file, which
  is how `pl.sql("SELECT * FROM df")` finds `df` at all. Aliases work, so
  `SELECT s.␣ FROM sales s` offers that table's columns and not the other one's.

  The scan is not a SQL parser and does not pretend to be. It masks out literals
  and comments and looks at what follows `FROM` and `JOIN`, which means every
  table is in scope everywhere in the statement: a join offers the union of both
  sides, marked uncertain because which side a bare name belongs to is genuinely
  unknown. Positions that are not columns — a table name, a quoted path, a string
  being compared against, a comment — offer nothing at all.

### Fixed

- **Accepting a completion inside a multi-name string replaced the whole string.**
  `rel.project("region, reve␣")` would swallow `region, ` along with the fragment.
  Only the identifier under the cursor is replaced now — in SQL, in
  `rel.project(…)` / `.order(…)` / `.aggregate(…)`, in `df.query(…)` and in
  `cs.starts_with(…)`.
- **A path inside a SQL string could be linked at the wrong offset** when the
  string contained an escape sequence such as `\n`, because the path was located
  in the decoded value and the range applied to the source. Both are measured in
  source offsets now. A statement that reads two files links both of them.

### Changed

- **Hover works inside a fragment.** Now that the range covers one identifier
  rather than the whole string, hovering a column name in a SQL statement shows
  its dtype and statistics like anywhere else.

## 0.1.9

### Added

- **An escape hatch for the frames that cannot be read.** A comment naming the
  file, for a path that arrives as a function parameter, a config attribute or an
  environment variable:

  ```python
  # polarsense: data/sales.parquet
  return pl.scan_parquet(cfg.source_path)

  def report(df):  # polarsense: data/sales.parquet
  ```

  It governs the statement it is attached to — trailing on the line, or alone on
  the line above — and on a `def` it answers for that function's parameters. It
  is consulted *last*, never first: a path the resolver can work out for itself
  always wins, so a pragma left behind after the code was fixed cannot start
  lying about a frame that is now readable. When the reader call is right there
  and only the path was unfoldable, the call still decides the format and its
  options — `pl.read_csv(cfg.path, separator=";")` stays a semicolon CSV.

  The format comes from the path's extension, and a bare directory is read as
  parquet. Delta and Iceberg tables are directories, so those say it outright:
  `# polarsense: delta data/warehouse/sales`. The path is ctrl-clickable like any
  other, which is the cheapest way to notice you typed the wrong one.

  The build plan spelled it `# polars-schema:`. The extension is no longer
  polars-only, so it takes its own name.

## 0.1.8

- **pandas and duckdb get the same treatment as polars.** `pd.read_parquet`,
  `pd.read_csv` and `duckdb.read_parquet` were already recognised as readers —
  what was missing was everywhere those frames are used. `groupby`,
  `sort_values`, `drop(columns=…)`, `rename(columns={…})`, `astype`, `set_index`,
  `merge`, `dropna(subset=…)`, `drop_duplicates`, `nlargest`, `value_counts`,
  `pivot_table` and `query` are all column sites now, and pandas transforms
  propagate: `df[["a", "b"]]` narrows, `assign` adds, `rename(columns=…)` renames,
  and a `merge` suffixes collisions `_y` rather than polars' `_right` — reading
  `suffixes=` when it is given.

  Supporting a second library turned out to be mostly the trigger table getting
  longer. Rows are keyed by method name and the receiver still has to resolve to
  a file, so a pandas row costs nothing in a polars file — no dialect detection,
  no second resolver.

- **duckdb's SQL is read for the file it opens.**
  `duckdb.sql("SELECT * FROM 'sales.parquet'")` resolves to that parquet file, as
  do `read_parquet('…')` and friends written inside the SQL, and the same through
  a connection's `.execute(…)` / `.query(…)`. The path inside the string is
  ctrl-clickable like any other. This is not a SQL parser and does not try to be:
  it looks for a reader call or a quoted path with a known extension and finds
  nothing otherwise, so `con.execute("SELECT * FROM users")` stays silent.

  From there the relational API completes — `.project(…)`, `.order(…)`,
  `.aggregate(…)` — and `.df()`, `.to_pandas()` and the other conversions are
  understood as column-preserving, so a duckdb relation turned into a pandas
  frame does not lose its schema on the way.

- **String arguments that hold an expression rather than a name** —
  `df.query("revenue > 100")`, `rel.project("region, revenue")` — complete full
  column names but are never typo-checked, the same treatment
  `cs.starts_with("reg")` already had.

### Fixed

- **`rename(columns={"old": "new"})` offered column names on both halves.** A dict
  key passed as a keyword argument was read as a keyword rather than a dict key,
  so the new name was treated as one that had to exist. The key and the value are
  told apart now, which also makes polars' `rename(mapping={…})` complete at all.
- **pandas CSV options were ignored.** `pd.read_csv(…, sep=";")` produced a single
  column whose name was the whole header row, because the reader only knew
  polars' `separator`. `sep`, `delimiter`, `delim`, `skiprows`, `comment`,
  `quotechar`, `names` and `header=None` are understood now.


## 0.1.7

### Added

- **Frames built in another file are visible now.** `from loaders import sales`
  or `from loaders import load_sales` followed by `load_sales().select("␣")`
  completes from the file `loaders.py` opens — as does `import loaders` with
  `loaders.sales` or `loaders.load()`, relative imports (`from .loaders import`),
  packages (`pkg/loaders.py`, `pkg/__init__.py`) and aliases of any of them.

  This was the largest remaining blind spot in what the resolver could see.
  Everything the analysis already does travels across the boundary intact: a
  chain built in the other module keeps its transforms, so
  `sales = pl.scan_parquet(…).select("a", "b")` in `loaders.py` narrows the offer
  where it is used, and its module-level path constants fold in their own file
  rather than being looked up in yours.

- **A function that returns a frame resolves to that frame**, in the file you are
  editing as much as an imported one. `def load(): return pl.scan_parquet(…)`
  then `load().select("␣")` used to find nothing. A `def` with several `return`s
  is read by trying each in turn; a `return` whose path comes from a parameter
  still resolves to no path, which is the honest answer rather than a guess.

  Only module-level `def`s — a method needs an instance this analysis cannot
  follow, so `Loader().load()` stays quiet.

  Modules are read on demand rather than indexed: only the ones the open file
  actually imports, two hops out, capped at sixteen files, each parse cached
  until its mtime changes. Nothing outside the workspace is opened, so `polars`
  and every other dependency simply resolve to no file. `polarsense.followImports`
  turns the whole thing off.

## 0.1.6

### Added

- **`polars.selectors` are understood** — `cs.by_name("region")`,
  `cs.starts_with("q_")`, `cs.exclude(…)` and friends complete column names, and
  `import polars.selectors as cs`, `from polars import selectors as cs` and
  `from polars.selectors import by_name` are all recognised as the alias.

  More usefully, a selector now *narrows* rather than stopping the analysis. The
  columns a selector picks are computed against the columns the frame actually
  has — by name for `by_name`, `starts_with`, `ends_with`, `contains` and
  `matches`, and by dtype for `cs.numeric()`, `cs.string()`, `cs.temporal()` and
  the rest — so `df.select(cs.numeric()).select("␣")` offers the numeric columns
  and nothing else. Selectors compose the way polars composes them: `|`, `&`,
  `-` and `^` between two selectors are union, intersection, difference and
  symmetric difference.

  This is one fewer reason for the unknown-column check to go quiet. A selector
  used to make everything downstream of it a guess; now only the ones that
  cannot be read statically do — `cs.by_dtype(pl.Int64)`, a selector method we do
  not model, or a dtype selector over a source whose dtypes were never read, such
  as a CSV with inference off.

  `cs.starts_with("reg")` holds a *fragment* of a name rather than a whole one.
  Those positions still complete full column names — you pick one and trim it —
  but the typo check and hover skip them, because "reg" is not supposed to be a
  column.

- **`df["region"]` and `df.get_column("region")`** are column sites now — they
  complete, hover and get typo-checked like every other position. Also
  `get_column_index` and `drop_in_place`, and the list and tuple forms
  `df[["a", "b"]]` / `df["a", "b"]`.

  A dict lookup is *structurally identical* to a frame one — `cfg["path"]` and
  `df["region"]` are the same syntax tree — so the receiver decides. If it does
  not resolve to a frame we know, nothing is offered at all: the all-schemas
  fallback is deliberately skipped here, or every dictionary key in a file that
  happens to import polars would sprout column names.

## 0.1.5

### Fixed

- **The packaged extension was 250 MB.** `.vscodeignore` is a denylist, so
  anything not named in it ships — and a local `.venv` was not named. 429 files
  of Python virtualenv, polars included, were inside the VSIX. Excluded now,
  along with previous `.vsix` files, `_sync`/`.tgz` scratch, `__pycache__`,
  `.DS_Store`, `pyproject.toml`/`uv.lock` and `RELEASING.md`. The package is back
  to 8 files and 207 KB.
- `npm run package` now fails if the result exceeds 5 MB
  (`scripts/check-vsix.mjs`), so this cannot recur quietly. Override with
  `VSIX_LIMIT_MB` if the extension one day genuinely gets bigger.


## 0.1.4

### Added

- **Unknown column names are flagged as you type**, with a quick fix offering the
  closest name — `df.select("regoin")` warns and offers `"region"`. Reported as a
  warning rather than an error: the file on disk can legitimately be older than
  the code that will run, and polars has the last word.

  The check is deliberately quiet. It reports only where the schema evaluator is
  `certain` — the frame was identified, its file was read, and every transform in
  between was one we model. An unmodelled reshape, a selector, an unresolved
  frame, an unreadable file or a schema clipped by `maxColumns` all mean silence.
  Turn it off with `polarsense.diagnostics.enable`.

### Changed

- **Hover names the source by path** rather than by basename. Two files both
  called `part-0.parquet` in different partitions were indistinguishable, which
  is exactly when knowing which one you are looking at matters.
- **Hover falls back the way the completion list does.** When the frame cannot be
  identified — a function parameter, say — completions still offer the union of
  every schema in the file, but hover gave nothing for the very name it had just
  offered. It now shows the column, and says plainly that the frame was not
  identified so the answer is a guess.

## 0.1.1

### Added

- **Data file paths complete themselves.** Typing inside `pl.scan_parquet("…")`
  now offers matching files and folders, filtered to the formats that reader can
  open. Only the segment after the last slash is replaced, and folders re-trigger
  the suggestion list so you can walk down a tree. Delta and Iceberg readers offer
  directories only, and mark the ones that are real tables.
- **Ctrl-click a data path to open the file.** Constants link too — a path built
  from a module-level string resolves to the file it points at. A glob or a
  directory resolves to one concrete file, and the tooltip names it.
- **Hover a column for its dtype and statistics.** Null count, min and max come
  from the same parquet footer already read for the schema, so they cost no extra
  I/O. Dates and timestamps are formatted rather than shown as epoch integers.
  Hovering a path shows the file it resolves to and its shape.
- **Column names propagate through transformations.** A frame is now its source
  plus the transforms applied to it, so completions reflect the columns that
  actually exist at that point in the chain:
  - `select`, `with_columns`, `drop`, `rename`, `with_row_index`
  - `group_by(…).agg(…)` — keys plus aggregates, while the frame inside `agg`
    still sees every input column
  - `join` reads both frames: shared `on=` keys drop from the right, colliding
    names take the suffix, and semi/anti joins offer only the left
  - `pl.all()`, `pl.exclude(…)`, `.alias(…)`, `.name.suffix(…)` and the
    aggregation methods are all understood as name-producing expressions
- **Uncertainty is shown rather than hidden.** An unmodelled reshape (`pivot`,
  `explode`, `transpose`), a selector like `cs.numeric()`, a regex column pattern
  or a computed rename key all keep the columns they had and mark them as a guess:
  those items sort below certain answers and say so. Narrowing wrongly is worse
  than admitting doubt.

### Fixed

- `read_csv(..., new_columns=["a", "b"])` produced a single column whose name was
  the two names fused together. A stray NUL byte had replaced the separator used
  to join list keyword arguments; list arguments now stay lists rather than being
  joined and re-split.
- Chained transforms after the first were silently invisible to the resolver,
  because the method name of `df.select(…).rename(…)` cannot be read from a dotted
  name — the receiver is a call. Replaced with a dedicated `methodName` helper.
- Collecting parquet statistics per column was quadratic and took a 5000-column
  file from 75 ms to 562 ms. Row-group statistics are now indexed in one pass.
- The analysis cache compares the document text as well as its version, so a stale
  parse can never serve a silently wrong completion.

### Security

- Declared `capabilities.untrustedWorkspaces: false` with an explanation. The
  extension reads files whose paths come from workspace source, so it stays
  disabled until you trust the folder. This was already VS Code's default for an
  undeclared extension; now it is explicit and the reason is visible.
- `polarsense.https.enabled` and `polarsense.pathRoots` are `machine`-scoped, so a
  cloned repository's own `.vscode/settings.json` cannot turn on network reads or
  add filesystem roots. Only your user settings can.

### Changed

- Marketplace metadata: publisher, repository, issues and homepage links, and an
  extension icon.
- The perf guards skip with a clear message when their generated fixtures are
  absent, instead of failing with ENOENT on a fresh clone.
- `docs/build-plan.html` and `docs/roadmap.html` document the design and what is
  deliberately not built yet. Both are excluded from the packaged extension.
- `scripts/make-gif.sh` turns a screen recording into a README-sized GIF.

### Internal

- 151 tests, up from 79. New suites cover expression naming, schema propagation
  and the document-link provider.
- New modules: `core/exprNames.ts` (what names an expression produces),
  `core/frame.ts` (the frame expression and its transform chain),
  `core/schemaEval.ts` (applying transforms to a column list).

## 0.1.0

First release.

- Column-name completions inside polars expression constructors (`pl.col` and
  friends) and frame methods (`select`, `group_by`, `join`, `rename`, …).
- Schemas read from parquet footers, CSV headers, Delta commit logs and Iceberg
  metadata pointers — no Python interpreter involved.
- Frame tracking through assignments, aliases, method chains and `pl.concat`
  within a single file, plus cross-cell tracking in notebooks.
- Path constant folding, workspace-relative resolution, globs and hive partitions.
- Schema cache keyed on file mtime, invalidated by a workspace file watcher.
