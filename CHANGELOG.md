# Changelog

## 1.8.0

### Changed

- **The chart-type picker moved to the right-hand end of the control row.** The
  pickers on the left choose what is being drawn; the chart type chooses how,
  which is a different question and now sits at the other end of the row.

### Added

- **A date column can be grouped by period.** The graph panel offers a `by`
  picker under the column picker it belongs to — `year`, `month`, `week`, `day`,
  `hour`, `minute`, `second` — and every row is moved to the start of its period
  before the rows are grouped. It sits beneath that select rather than beside the
  others because it is an argument to it, not a fifth control of equal standing,
  and it is not there at all when the column is not a date. It applies to all three charts a date can be: the rows
  counted per period, a line per label counted per period, and a numeric column
  measured per period — the last of which brings the aggregate picker back, so
  `sum revenue by month` is two picks. One count per period reads as bars as
  fairly as it reads as a line, so bars join the chart list where there is a
  single line to draw; two lines of bars would interleave, so they do not.

  The default is `exact`, which is the behaviour as it was: distinct values
  while there are few enough of them to be points on a line, and thirty buckets
  across the range when there are not. That fallback exists because a
  microsecond timestamp is its own value on every row; the picker is the answer
  given rather than guessed, and it is the reason the fallback is now rarely
  what you want.

  Periods are cut on UTC, because every date this extension prints goes through
  `toISOString` — grouping on the local clock would file a row under a month the
  panel does not show it in. A week starts on Monday, as ISO 8601 says; whether
  your locale starts it on Sunday is a question this does not ask.

## 1.7.0

### Added

- **The shape of a column, drawn.** `PolarSense: Show graph (reads rows)` opens
  a panel beside your code holding a chart of the file behind the frame at your
  cursor, and the notebook bar carries a third button — *Graph* — that opens the
  same panel for the frame a cell printed.

  Which chart you get is a lookup over dtypes and nothing cleverer: one numeric
  column is a histogram, one column of labels is a bar of counts, a date against
  a number is a line, two numbers are a scatter, and labels against a number are
  a bar of means. What that bar measures is a pick of its own — `count`, `sum`,
  `mean`, `median`, `min`, `max` — and the axis says which, because a bar of
  means and a bar of totals look identical and answer different questions.
  Counting says `rows`, since counting rows is not counting revenue. The picker
  appears only where there is something to choose: one column of labels can only
  be counted, and a scatter draws the rows themselves.

  **A date against a column of labels is one line per label.** Put a datetime on
  x and a string column on y and you get the rows counted at each point of the
  axis, split into a line per value, with a colour and a legend — six lines at
  most, because that is how many chart colours a VS Code theme has, and the
  panel says how many values it left out. Where every row carries its own
  timestamp, counting one point per distinct value would draw a flat line of
  ones, so the rows are counted in thirty buckets across the range instead and
  the panel says that is what happened. Two columns of labels are still refused:
  that is a cross-tabulation, which is a table. A numeric column holding a dozen distinct values or fewer — a
  rating, a status code — is drawn as bars instead, since thirty bins over five
  values is a comb rather than a distribution. Two picks and a chart type sit
  above the plot, so a default that is wrong costs one click; the type list only
  ever offers what those two columns can actually be drawn as.

  **The rows do not leave the extension.** A histogram of four million rows is
  thirty numbers, and thirty numbers are what cross to the panel — the same rule
  the data panel is built on, applied where it matters more. The chart is drawn
  in hand-written SVG and takes no new dependency; the bundle grew by 20 KB,
  which is about what a charting library costs before it has drawn anything.

  What it deliberately does not do: no filtering, no grouping by more than one
  column, no second series, no trend line. It reads at most
  `polarsense.graph.maxRows` rows (100,000) of the one or two columns being
  drawn, and says *a sample* on the panel whenever it stopped short of the file
  — a histogram of the first tenth of a file, captioned as the file, is exactly
  the kind of quiet wrongness this extension is built to avoid. A list or struct
  column is not offered as an axis at all, because a chart of a list is a chart
  of nothing.

  Charts come from parquet and CSV, like rows. A CSV is charted out of the same
  bounded prefix its header comes from and says so; a CSV also has no dtypes, so
  there the family of a column is read off its values — a column that parses as
  numbers nine times in ten is numbers. Arrow IPC, Delta and Iceberg say which
  half is missing rather than drawing an empty plot.

### Internal

- `src/schema/series.ts` reads one or two columns unformatted and capped, which
  is a third kind of read beside the schema and the page: a bin count needs a
  whole column, and cannot be computed from a hundred rows formatted for a grid.
- `src/schema/chart.ts` is pure and holds both halves of the feature — the dtype
  lookup and the binning, counting and sampling — so what chart a pair of columns
  gets can be tested against a list of values rather than against a file.
- The exported API gained `readChart(frame, request)`. It returns the aggregate
  rather than the values, so aggregating in the host is a property of the API and
  not merely of the panel that happens to call it today.

## 1.6.1

### Changed

- **The panels and the notebook buttons were given one look instead of two.**
  Both panels drew their own copy of the same stylesheet, and the copies had
  already drifted; there is now a single `PANEL_CSS` they share, so the details
  panel is the data panel with a different table in it and looks like it. The
  header is tighter — the file, its symbol, the path, then the facts as one
  muted line rather than a row of bordered chips — and the table fills the panel
  height instead of a hard-coded `100vh - 13rem`.

  In the grid: columns are as wide as what is in them rather than stretched
  evenly across the panel, numeric columns are right-aligned with tabular
  figures so digits line up under each other, rows highlight under the pointer,
  and the row index keeps a hairline against the data instead of blending into
  it. Row and column paging are two segmented groups reading `‹ rows 0–99 of
  200 ›`, which is the same information in half the width.

  The notebook bar is a single bordered pill — a quiet `PolarSense` label and
  two flat buttons — sitting at 72% opacity until the pointer is on it, because
  it appears under every frame in the notebook and should not compete with the
  data above it. Focus outlines are on all of it.

  Every colour is a VS Code theme variable, so this follows the editor's theme
  rather than picking greys that are wrong in half of them.

- **The grid says what kind of column each one is, in colour.** A dtype is
  reduced to the family that matters — text, whole numbers, fractions, flags,
  points in time, things with a shape inside them — and that family colours the
  dtype under the column name and washes the column itself at about 6% opacity.
  Reading across forty columns is mostly asking "what kind of thing is this",
  and a colour answers faster than the name does. A null cell takes no wash, so
  an empty cell is the one thing on the row that is not tinted. The colours are
  the theme's own chart colours, which is what keeps them legible in themes
  nobody here has seen; a dtype not recognised gets no colour rather than a
  guessed one. The details panel colours its Type column from the same rule —
  computed in the host and sent, so the page holds no copy of it.

- **Pagination reads as position rather than as a sentence.** The pager says
  `↑ 100–199 ↓` and `‹ 1–8 ›`: the range you are looking at, and nothing else.
  How many rows and columns the file holds is a fact about the file and the
  header already said it, twice over. Rows page with up and down, which is the
  direction they actually move.

- **The next page is also at the edge you ran out of data at.** When the grid
  is scrolled to its bottom and there are more rows, an arrow appears there;
  the same at the top, and at either side for columns. They show only when both
  things are true — you are at that edge *and* there is more that way — so an
  arrow is an offer rather than furniture floating over the data.

- **The path is a different colour from the numbers under it.** It answers a
  different question (where the data is, not what is in it) and now looks like
  it. The column headers and the row index have a background of their own,
  which is what stops a wide table reading as one undifferentiated sheet.

## 1.6.0

### Added

- **Buttons under a DataFrame printed in a notebook.** A cell that ends in a
  frame now carries *Details* and *Data* under its output, opening the same two
  panels the command palette opens, for the frame that cell built. **No kernel
  is involved and none is needed:** the button says which output was clicked,
  the cell's last statement says which frame that is, and the resolver says
  which file is behind it — so the buttons work in an `.ipynb` that has never
  been run, on a frame defined eight cells earlier.

  Two buttons, not three: the graph is not built yet, and a button that opens
  nothing is worse than no button.

  Which cell an output belongs to is answered exactly where it can be and
  plausibly where it cannot. VS Code hands the renderer an output id, but
  `NotebookCellOutput` does not carry one in the extension API, so when the
  match misses the focused cell answers instead — clicking inside an output is
  what focuses the cell holding it. When that misses too, the panel says so
  rather than opening on whichever frame was nearest.

  A cell whose frame is built in memory — `pl.DataFrame({...})` — gets a
  sentence saying there is no file to read, which is the same limit the panels
  have always had, now visible in the place where it is most tempting to
  assume otherwise.

### Changed

- **PolarSense renders `text/html` notebook output.** Carrying a button under
  the output means registering a renderer for that mime type, and VS Code has
  no supported way to *add* to the built-in HTML renderer — so this one stands
  in its place, for every HTML output in the notebook rather than only for
  frames. It draws them the way the built-in renderer does, scripts included,
  so charts and rich displays are unaffected; if something renders differently
  under PolarSense, that is a bug and worth reporting. `notebook.buttons` turns
  the bar off and leaves the rendering exactly as it is.

### Internal

- `showDetails` and `showData` take where to look rather than reading the
  active editor's cursor themselves, because a button under a cell output is a
  second way in and there is no cursor in it. Same resolver, same failure
  message for a cursor, a different one for a cell.
- The renderer is a second esbuild bundle — browser platform, ESM, no `vscode` —
  with its own `tsconfig` so the DOM stays out of the extension host's types.
  The only thing the two bundles share is the pure module that decides whether
  an HTML output looks like a frame and where a cell's last statement begins.

## 1.5.0

### Added

- **A paginated table: the file behind your frame, a page at a time.**
  `PolarSense: Show data (reads rows)` opens a panel beside your code holding a
  hundred rows of the file the frame at your cursor reads, with the row index
  stuck to the left edge and the header row stuck to the top. `rows ›` fetches
  the next hundred; for parquet the footer's row count says how many there are
  before a single row is decoded, so the pager knows where the end is.

  A wide frame is navigated rather than rendered. Forty columns are drawn at a
  time, `columns ›` steps the window along, and the filter box narrows the list
  it steps over — a 5,000-column file is as usable as a five-column one, which
  is the half of this that is easy to forget. Column navigation matters as much
  as row navigation on the frames that need a viewer at all.

  **Nothing crosses into the panel that is not being drawn.** The page that is
  on screen is the read: this row range, these columns, and parquet stores
  columns independently, so forty of five thousand costs forty. Rows are not
  cached, either — a page is a bounded read of a file the OS still has warm, and
  holding someone's data in memory after the panel closed would be the wrong
  trade. Nothing reads a file end to end, and nothing opens by itself.

- **CSV pages, and says that a prefix is a prefix.** A CSV has no footer, so
  there is no row count to claim and no offset to seek to. The rows come out of
  the same bounded prefix the header read already takes — `csv.sniffBytes` — and
  the panel says so in a sentence rather than implying the file is that short.
  The last record in a truncated prefix is dropped: the read stopped mid-line,
  and half a row shown as data is worse than a row not shown.

- **`readRows` on the exported API.** `api.readRows(frame, { rowStart, limit,
  columns })` returns a page of the file behind a resolved frame, along with
  every column name the file has so a caller can offer the ones it is not
  drawing. `ResolvedFrame` also carries `kwargs` now — `separator=`, `quote_char=`
  — because what the bytes of a CSV mean depends on them as much for a page as
  for a header.

### Changed

- **A frame's transforms are named on both panels, in the same words.** The
  details panel and the table share one header: the file, its shape, and
  `transforms not applied` when the frame at the cursor is a filter, a select or
  a join away from the file being shown. The table adds what the file cannot
  answer — a column the frame computed or renamed is not offered, because the
  file has never heard of it.

### Internal

- **Value formatting is one function.** The parquet footer's statistics and the
  cells of a page are the same problem — hyparquet hands back whatever the file
  holds and only the dtype says what it means — so `schema/format.ts` now does
  both, with lists and structs rendered as JSON rather than as `[object Object]`.
- **The CSV reader's header walk is reusable.** `csvTable` takes a window of
  records, so the schema read asks for the header and fifty rows to guess dtypes
  from, and the preview asks for a page — one parser, one set of `separator=` and
  `quote_char=` rules, one place to be wrong.

## 1.4.0

### Added

- **A details panel: the hover, per column, in a panel beside your code.**
  `PolarSense: Show details` resolves the frame at the cursor and lists every
  column it has with its dtype, null count, min and max — the same facts the
  hover shows one at a time — under a header naming the file, its row count,
  its size, its row groups and the codec its pages are written with.

  It reads nothing the completions have not already read. Every number on it
  comes out of the parquet footer that was read for the schema, which is why it
  opens on a four-million-row file as fast as on a small one, and why it needs
  no setting guarding it the way `values.enable` guards value completion. It
  never opens by itself, and it opens beside your code without taking focus.

  What the footer cannot give is left off rather than estimated: no distinct
  counts, no mean, no quantiles. A file that recorded no statistics at all — a
  CSV — gets a list of names rather than a grid of blanks, and a statistic the
  writer left out prints an em dash rather than a zero, because "no nulls" and
  "the writer did not say" are different answers.

  When the frame at the cursor is a filter, a select or a join away from the
  file, the panel says `transforms not applied` and spells out which numbers are
  the frame's and which are the file's. It is showing you the source, and the
  one way it could be quietly wrong is by not admitting that.

- **The API carries what the footer says about the *file*.** `resolveFrameAt`
  now also answers with `sizeBytes`, and for parquet `rowGroups` and
  `compression`. The row groups and the codec fold into the statistics walk the
  reader already made, and the size is the `stat` the cache key already needed,
  so this costs no extra read.

### Internal

- **The details panel is a consumer of the exported API, not a second copy of
  the resolver.** It calls `resolveFrameAt` in-process exactly as another
  extension would call it across the boundary, which is what keeps moving the
  viewer into its own extension a packaging change rather than a rewrite.

## 1.3.0

### Added

- **`activate()` returns an API, so another extension can ask which file a frame
  reads.** `exports.resolveFrameAt(uri, position)` answers with the resolved
  file, its format, the columns that exist at that position with whatever
  statistics the file's own metadata gave up, and the file's row count — the
  same resolution the completions run on, handed out instead of kept. Two flags
  come with it and are the point of the shape: `certain` is false when a
  transform could not be modelled, and `transformed` says the frame is the
  source with a filter or a select applied, so anything reading rows from `uri`
  is reading the file rather than the frame and has to say so.

  This is step 1 of `docs/roadmap-v2.html`: the data viewer needs exactly this
  answer, and exporting it now means the viewer can move into its own extension
  as a packaging change rather than a rewrite. Nothing calls it yet, and the
  extension behaves identically without a caller.

  It deliberately does not read rows, does not open a document that is not
  already open unless VS Code can, and returns `undefined` — never a partial
  answer — where there is no frame, no file, or no readable schema. `activate()`
  itself returns `undefined` when the parser failed to start, so a caller checks
  once rather than per call.

### Internal

- **`frameAtOffset` resolves the frame a cursor is *on*.** The existing
  resolver answers "what column name belongs in this string", which is the wrong
  question for a viewer: the cursor is on `df`, not inside a column. The new
  entry point walks out from the cursor to the widest expression that still
  resolves, which also means `df.filter(...).select(...)` comes back with its
  transform chain rather than as the bare file it started from.

## 1.2.1

### Added

- **`read_excel` honours `sheet_name=` and `sheet_id=`.** 1.2.0 shipped the Excel
  reader opening `xl/worksheets/sheet1.xml` and nothing else, so asking for a
  particular tab answered with whichever sheet happened to be stored there. It
  now reads `xl/workbook.xml` for the tabs in tab order and
  `xl/_rels/workbook.xml.rels` for the part each one lives in, and picks from
  those — two more members out of a zip that was already open.

  polars spells the position `sheet_id` and counts from one; pandas overloads
  `sheet_name`, where a number is a position counted from zero. Both are
  understood, because both call sites reach the same reader.

### Fixed

- **The first sheet is the first *tab* now, not `sheet1.xml`.** That part name is
  not a position — a workbook whose tabs have been reordered can keep its first
  tab in `sheet3.xml` — so `pl.read_excel("book.xlsx")` with no arguments could
  quietly complete against the wrong sheet. The workbook walk added above fixes
  the default at the same time as the explicit case, which is most of why it was
  worth doing.

- **A sheet that is not in the workbook now says nothing.** Asking for
  `sheet_name="Q2"` where there is no Q2 used to return sheet one's columns,
  which was the one place this reader could be confidently wrong rather than
  quiet. The fallback to `sheet1.xml` went with it: a file with no readable
  `workbook.xml` reports nothing instead of guessing at a part name.

## 1.2.0

### Added

- **NDJSON, JSON and Excel are read now.** `scan_ndjson`, `read_ndjson`,
  `read_json` and `read_excel` join the reader table, so a frame built from one
  of them completes its column names like any other.

  The JSON side turned out to be one reader rather than three. The shapes polars
  accepts — an array of row objects, newline-delimited objects, a single object —
  are all just top-level `{…}` runs in order, so nothing has to be sniffed or
  told apart: a brace-depth scanner that ignores braces inside strings walks the
  same bounded prefix `csv.sniffBytes` already governs, and an object the read
  cut in half is dropped rather than ending the scan. Fifty objects are sampled,
  not one, because polars unions keys across rows and so must this — a key absent
  from the first row is still a column, and the first row with a non-null value
  for a key is what decides its dtype. Nested objects keep their own fields, so
  `.struct.field("…")` answers for them the way it does for parquet.

  Excel needed no dependency, which was the surprise. `.xlsx` is a zip of XML and
  node's own `inflateRawSync` decodes the one method a spreadsheet writer ever
  uses, so the header row is a central-directory read and two regexes. Shared
  strings are resolved, rich-text runs are joined, and a skipped cell is *named*
  rather than closed up — Excel omits an empty cell entirely, and closing the gap
  would quietly shift every column after it under its neighbour's name.

  What they deliberately do not do: Excel reads `sheet1.xml` and nothing else, so
  `sheet_name=` is not honoured yet, and `.xls` — OLE2, a different format
  wearing a similar extension — reports nothing rather than guessing at its
  bytes. A JSON number reads as `i64` unless a sampled row is fractional, since
  `1.0` and `1` are the same value once parsed. Excel columns carry no dtype at
  all, on the same grounds CSV inference is off by default: a blank is better
  than a guess shown as fact. Values stay parquet-only.

## 1.1.0

### Added

- **The string-matching methods take values now, not just `==`.** Value
  completion answered on `== "…"`, `!=`, `.is_in([…])`, `.eq`/`.ne` and a
  constraint keyword; `df.filter(pl.col("region").str.contains("␣"))` — the way
  most people actually reach for a value — was silent. It now offers the
  column's values, as do `.str.starts_with`, `.str.ends_with`,
  `.str.contains_any`, `.str.find` and `.list.contains`. The change is one
  longer set in `triggerSites.ts`: the value table is keyed by method name like
  every other trigger row, and `.str`/`.list` were already namespaces the name
  walk passes through, so the receiver still has to resolve to a single column
  of a file we can read.

  That receiver is also what keeps `cs.contains("reg")` working as before —
  the same method name means the opposite thing there, a fragment of a column
  *name*, and `cs` names no column, so that site is untouched.

  What it deliberately does not do: escape anything. `contains`, `contains_any`
  and `find` match a regex unless `literal=True` is passed, so a value holding
  `.` or `(` is offered as a pattern that will mean something else once
  inserted — a starting point to trim rather than a finished argument. The list
  is not filtered to values that would still match what you have typed either,
  and, as everywhere else in value completion, nothing checks the result: a
  value site is never typo-checked and never hovered.

## 1.0.3

### Fixed

- **The value-completion toggles no longer dead-end on "polarsense.values.enable
  is not a registered configuration."** VS Code refuses to write a settings key
  its configuration registry does not hold, and the registry is filled from the
  manifest of the extension copy the window resolved — not necessarily the copy
  whose code is running. Two PolarSense copies in one window (a Marketplace
  install alongside an Extension Development Host, or a folder an interrupted
  update left behind in `.vscode/extensions`) make those diverge: the duplicate
  manifest's properties are rejected as already registered, and the command can
  end up running with no key to write. *PolarSense: Turn on value completion*
  now asks the registry before it writes and says what is actually wrong, with
  a **Reload Window** button, rather than surfacing VS Code's message about a
  setting the extension plainly does declare. A write that fails for any other
  reason — a settings file managed by policy, or one that is read-only — is
  reported rather than thrown into the void, and goes to the PolarSense log.

  This does not make the toggle work in a window whose registry is missing the
  key; nothing in an extension can. It replaces an error that reads as a broken
  command with one that names the thing to fix.

## 1.0.2

### Added

- **Columns a reshape creates are now offered.** `transpose`, `unnest`,
  `unpivot`/`melt` and `explode` used to end the analysis: the extension knew the
  frame had changed shape, could not say how, and fell back to offering the
  source file's original columns marked as a guess. Each of them is now evaluated
  where the call says enough to evaluate it.

  `df.transpose(column_names=["null_count"], include_header=True,
  header_name="column")` completes `column` and `null_count`, because
  `column_names` states the whole output schema. That makes it the one transform
  whose answer is *certain even when its input was not* — the input's columns
  became rows, so what they were called stopped bearing on the result. A
  `transpose` with no `column_names` is still unknowable, since polars would name
  the columns `column_0…` and how many there are is the input's row count.

  `df.unnest("address")` replaces the struct with its own fields, in its place —
  the schema readers already carry the field tree, so nothing new had to be read.
  `df.unpivot(index=["region"])` gives `region`, `variable` and `value`, honouring
  `variable_name`/`value_name` and pandas' `id_vars`/`var_name` spellings.
  `explode` turns list elements into rows without touching the names at all, so it
  is now simply schema-preserving, as are the whole-frame reducers — `null_count`,
  `sum`, `mean`, `min`, `max` and the rest — which return one row with every
  column still named.

  What still says nothing: `pivot`, `pivot_table` and `to_dummies`, whose columns
  are the *values* in the file rather than anything in the code. Nor is an
  `unpivot` read when its arguments are positional — polars puts `on` first and
  pandas' `melt` puts `id_vars` there, and reading one as the other would not
  fail, it would quietly produce the other library's column list. An `unnest` of a
  name the frame does not have, or of a struct whose fields were never read, keeps
  the struct column and drops certainty rather than dropping the column.

## 1.0.1

### Added

- **Two command palette entries for value completion**: *PolarSense: Turn on
  value completion (reads your data)* and *PolarSense: Turn off value
  completion*. They write `polarsense.values.enable` and say what changed — the
  setting is still the only state, so nothing goes out of step with it.

## 1.0.0

### Added

- **Value completion.** `df.filter(pl.col("region") == "␣")` now offers `US`,
  `EU`, `APAC` — the values the column actually holds, read out of the file.
  Also on `!=`, `.is_in([…])`, `.eq`/`.ne`, and on the right-hand side of a
  constraint keyword, `df.filter(region="␣")`, whose left-hand side has always
  completed column names.

  **It reads your data.** Everything else here reads metadata — a footer, a
  header row, a commit log — and this reads rows, so it is off until you turn it
  on with `polarsense.values.enable`. What it reads is one column of the first
  `values.maxRows` rows; parquet is columnar, so that is one column chunk rather
  than a scan, and the answer is cached against the file's mtime like a schema —
  including the answer "there is nothing worth offering", so a four-million-id
  column is asked about once rather than once per keystroke.

  Silence is the answer more often than not, on purpose. More than
  `values.maxDistinct` distinct values (50 by default) offers *nothing* rather
  than a truncated list — a hundred of four million order ids is not a
  completion list, it is a claim about how many there are. Columns whose values
  are not strings offer nothing either: a value site is always inside quotes,
  where a float would be the wrong literal. Nor does a column the file has never
  heard of, which is what a rename upstream leaves behind.

  When the read did not cover every row, each item says `value (sampled)` and
  the tooltip says how many rows it saw. Hive partition columns are the one case
  that is never a sample and never reads data at all: the partitioning *is* the
  list, so `region=EU/`, `region=US/` are the values, read from the directory
  names.

  Parquet only. Delta and Iceberg would mean finding their data files first, and
  Arrow IPC would mean decoding its buffers — both are more than a column read.
  Values are never typo-checked and never hovered: they are data, and the
  unknown-column warning would fire on every value anyone filters on.

### Changed

- **A Delta checkpoint compressed with zstd reads now.** Value completion needed
  a zstd decompressor — polars writes it by default — and the checkpoint reader
  is the other place a parquet *page* is decompressed rather than a footer read,
  so it got the same one. `fzstd` is the third runtime dependency: decompression
  only, plain JavaScript, no dependencies of its own. Brotli and LZ4 still report
  nothing.

## 0.5.0

### Added

- **Arrow IPC files complete their columns.** `pl.scan_ipc`, `pl.read_ipc`,
  `pl.read_ipc_stream` and `pl.read_feather` used to resolve to a file and then
  report nothing: the reader behind them was a stub that returned an empty list.
  It reads the schema now — names, dtypes and a struct's own fields, the same as
  the parquet reader gives — and `read_ipc_stream` was added to the reader table
  while the format it names finally works.

  The schema is a flatbuffer, and this walks its vtables by hand rather than
  taking a dependency on an Arrow implementation whose real job is decoding the
  buffers underneath — the part this extension deliberately never touches. It is
  two range reads and no decompression, so the cost does not move with the size
  of the file, which is the same bargain the parquet reader makes.

  The plan said the schema sits at the head of the file. That is true of a
  stream, and it is where a stream is read; it is not dependable in a file,
  because polars writes that first message with no length prefix in front of it,
  and a reader scanning forward walks straight off the end. A file is read
  through its footer instead — the index its own spec puts there.

  Dtypes are the ones polars actually writes today, which the parquet fixtures
  never exercised: `Utf8View` and `BinaryView` rather than `Utf8` and `Binary`,
  `LargeList`, a fixed-size list as `array[f64, 2]`, and a dictionary-encoded
  string as `cat` — the encoding is what makes it a categorical rather than a
  `str`. Interval and union columns come back with a blank dtype rather than an
  invented name, and Feather V1 — a different format that happens to share the
  `.feather` extension — is left alone rather than misread.

## 0.4.0

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
