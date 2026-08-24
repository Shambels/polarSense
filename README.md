# PolarSense

Column-name autocompletion for [polars](https://pola.rs), read from the file your
DataFrame actually comes from.

```python
import polars as pl

df = pl.scan_parquet("data/sales.parquet")
out = df.select(pl.col("re␣"))
#                      ◆ region      str
#                      ◆ revenue     f64
#                      ◆ returns_qty i32
```

Polars column names are strings, so no type checker can see inside them. But the
schema is sitting in the file on disk — a parquet footer, a CSV header row, a Delta
commit log, an Iceberg metadata pointer. PolarSense reads it and offers the names.

It never imports polars, never spawns a Python interpreter, and never runs your
code. It reads bytes out of your data files and nothing else.

## What it completes

Column names inside string literals, wherever polars expects one:

- `pl.col`, `pl.exclude`, `pl.struct`, `pl.concat_str`, and the aggregate shortcuts
  (`pl.sum("x")`, `pl.first("x")`, …)
- `select`, `with_columns`, `drop`, `filter`, `explode`, `unique`, `drop_nulls`
- `sort`, `top_k`, `bottom_k`, `group_by`, `agg`, `partition_by`, `group_by_dynamic`
- `join` and `join_asof` — including `right_on=`, which completes from the frame
  being joined in rather than the receiver
- `rename` and `cast` dict keys, `pivot`, `unpivot`, `over`, `sort_by`

Column names are propagated through transformations, so what you are offered is
what actually exists at that point in the chain:

```python
narrow = df.select("region", "revenue").rename({"revenue": "rev"})
narrow.select("␣")           # region, rev — not the other seven columns

joined = a.join(b, on="region")
joined.select("␣")           # both frames' columns, collisions suffixed _right

df.group_by("region").agg(pl.col("revenue").sum()).select("␣")   # region, revenue
```

It finds the frame by tracking assignments within the file:

```python
df     = pl.scan_parquet("data/sales.parquet")
recent = df.filter(pl.col("date") > cutoff)   # alias — same schema
joined = recent.join(dim, on="region")        # still the same schema
joined.select("␣")                            # completes
```

Paths do not have to be literals. Module constants, `+` concatenation, f-strings
without interpolation, `Path(...) / "file.parquet"` and `os.path.join(...)` are all
folded down to a path before the file is opened. Relative paths are tried against
the file's own directory, then each workspace folder, then `polarsense.pathRoots`.

Globs and directories resolve to the first matching file, and `key=value` directory
segments are added as hive partition columns, the way polars adds them.

## Formats

| Format | How the schema is read |
| --- | --- |
| Parquet | Footer only — two range reads, independent of file size |
| CSV | Header row, honouring `separator`, `has_header`, `skip_rows`, `comment_prefix`, `quote_char`, `new_columns` |
| Delta | `_delta_log` walked newest-first to the most recent `metaData` action |
| Iceberg | `metadata/version-hint.text` → the current schema in that metadata file |

Notebooks are supported: every code cell above the cursor is treated as one module,
so a frame defined in cell 1 completes in cell 8.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `polarsense.enable` | `true` | Turn completions off without uninstalling |
| `polarsense.pathRoots` | `[]` | Extra directories to try for relative paths |
| `polarsense.fallbackToAllSchemas` | `true` | When the frame can't be identified, offer every schema in the file |
| `polarsense.maxColumns` | `5000` | Cap on items offered for one schema |
| `polarsense.csv.sniffBytes` | `262144` | How much of a CSV to read looking for the header |
| `polarsense.csv.inferDtypes` | `false` | Guess CSV dtypes from the first rows |
| `polarsense.https.enabled` | `false` | Allow reading schemas over `https://` |
| `polarsense.cacheSize` | `200` | File schemas held in memory |
| `polarsense.trace` | `false` | Log every resolution to the PolarSense output channel |

The status bar shows what the frame at your cursor resolved to, or why it didn't.
`PolarSense: Show log` has the detail; that's what to attach to a bug report.

### If nothing appears

VS Code suppresses quick suggestions inside strings by default. PolarSense ships a
default that turns them on for Python, but a setting of your own takes precedence:

```jsonc
"[python]": { "editor.quickSuggestions": { "strings": "on" } }
```

<kbd>Ctrl</kbd>+<kbd>Space</kbd> always works regardless.

## Known limitations

These are deliberate, not oversights — the analysis is single-file, and some
reshapes are beyond what static reading can predict.

- **Some reshapes are not modelled.** `pivot`, `unpivot`, `explode`, `transpose`
  and friends change the columns in ways this does not attempt to predict. The
  extension keeps offering the columns it had and marks them as a guess — they
  sort below certain answers and say so in the tooltip.
- **Selectors are opaque.** `cs.numeric()`, regex patterns like `"^total_.*$"` and
  computed names cannot be read statically, so a `select` using them widens rather
  than narrows, and is again marked uncertain.
- **Frames crossing module boundaries are invisible.** A frame built in
  `loaders.py` and imported gets nothing.
- **Frames from function parameters or config objects are invisible.** A type
  annotation carries no path.
- **Multi-file globs assume one schema.** First match wins.
- **Object storage is not supported.** `s3://` and `gs://` resolve to nothing and
  stay quiet. `https://` works when enabled.
- **Dtype names are our translation**, not polars' own, so nested and
  timezone-aware types may read slightly differently than `print(df.schema)`.
- **Notebook order is document order.** Cells run out of order resolve as if they
  hadn't been.
- **Delta tables whose JSON commits have been truncated** by a checkpoint report
  nothing rather than something stale.

## Development

```bash
npm install           # required once: esbuild and the parser live here
npm run fixtures      # needs polars; writes test/fixtures/data
npm run build
npm test
npm run package       # produces the .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host on `test/fixtures`,
with `example.py` ready to type into. The F5 build task runs `npm install` for you,
so a fresh clone works — but on a slow connection the first launch waits for it.

`dist/extension.js` is a self-contained bundle — once built, *running* the extension
needs no dependencies at all, which is why the packaged `.vsix` is around 200 KB and carries
no `node_modules`. **Run PolarSense (skip build)** in the debug dropdown launches the
existing bundle without rebuilding. `dist/` is gitignored; CI and `npm run package`
build it.

Note that `node_modules` must be installed on the machine that runs the extension:
esbuild and the tree-sitter runtime ship platform-specific binaries, so a copy
installed on another OS will not work.

[`docs/build-plan.html`](docs/build-plan.html) is the design document this was built
from — the architecture, the resolution algorithm, and the deliberate limitations.

The analysis layer (`src/core`, `src/schema`, `src/storage`, `src/paths.ts`) never
imports `vscode`, so it is testable in plain node — that is what `test/unit` runs
against. `test/unit/extension.test.mjs` activates the *bundled* extension against a
stub of the VS Code API, which is what catches bundling and activation failures.

### Releasing a new version

Write the changelog entry first and commit it — `npm version` refuses to run on a
dirty tree, and the changelog is the check on whether the number you picked matches
what actually changed.

```bash
# 1. edit CHANGELOG.md, then
git commit -am "changelog for 0.1.2"

# 2. one command: tests, bump, commit, tag, package
npm version patch          # 0.1.1 -> 0.1.2   fixes only
npm version minor          # 0.1.1 -> 0.2.0   new features
npm version major          # 0.1.1 -> 1.0.0   breaking change

# 3. push, then upload the .vsix
git push --follow-tags
```

That single command does five things, via npm's own lifecycle hooks in
`package.json`:

| Hook | Runs | Why |
| --- | --- | --- |
| `preversion` | `npm test` | A failing test aborts the bump — no commit, no tag |
| — | version bump | Updates `package.json` **and** both fields in `package-lock.json` |
| — | commit + tag | `v0.1.2`, from npm itself |
| `postversion` | `npm run package` | Leaves `polarsense-0.1.2.vsix` ready to upload |

Push **before** updating the Marketplace listing: the README's GIF is served from
GitHub at render time, so an unpushed commit shows a broken image on the page.

To bump without touching git — useful when you want the version change in the same
commit as something else — add `--no-git-tag-version`. The hooks still run.

[`RELEASING.md`](RELEASING.md) has the rest: how to choose the number, the
marketplace gotchas, and a checklist.

## Privacy

No telemetry. Nothing leaves your machine except the byte ranges of the data files
you point it at, and only over `https://` if you turn that on.

## Licence

MIT
