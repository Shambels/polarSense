# Changelog

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
