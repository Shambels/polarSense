# Changelog

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
