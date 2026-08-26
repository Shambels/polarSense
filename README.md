# PolarSense

Column-name autocompletion for [polars](https://pola.rs), pandas and duckdb, read
from the file your DataFrame actually comes from.

```python
import polars as pl

df = pl.scan_parquet("data/sales.parquet")
out = df.select(pl.col("re␣"))
#                      ◆ region      str
#                      ◆ revenue     f64
#                      ◆ returns_qty i32
```

Column names are strings, so no type checker can see inside them. But the schema is
sitting in the file on disk — a parquet footer, a CSV header row, an Arrow IPC
footer, a Delta commit log, an Iceberg metadata pointer. PolarSense reads it and
offers the names.

It never imports polars, never spawns a Python interpreter, and never runs your
code. It reads bytes out of your data files and nothing else — and by default only
the metadata part of them. One feature reads the rows themselves, and it is off
until you [turn it on](#values-if-you-ask-for-them).

## What it completes

Column names inside string literals, wherever polars expects one:

- `pl.col`, `pl.exclude`, `pl.struct`, `pl.concat_str`, and the aggregate shortcuts
  (`pl.sum("x")`, `pl.first("x")`, …)
- `select`, `with_columns`, `drop`, `filter`, `explode`, `unique`, `drop_nulls`
- `sort`, `top_k`, `bottom_k`, `group_by`, `agg`, `partition_by`, `group_by_dynamic`
- `join` and `join_asof` — including `right_on=`, which completes from the frame
  being joined in rather than the receiver
- `rename` and `cast` dict keys, `pivot`, `unpivot`, `over`, `sort_by`
- `df["region"]`, `df[["a", "b"]]`, `get_column`, `get_column_index`, `drop_in_place`
- `polars.selectors` — `cs.by_name`, `cs.exclude`, `cs.starts_with`, `cs.ends_with`,
  `cs.contains`
- `df.filter(region="EU")` and `df.remove(…)` — polars' constraint keywords, the
  one column position that is not inside a string
- `pl.col("address").struct.field("␣")` — a struct's own fields, as deep as they
  go, and `df.unnest("␣")`

### Values, if you ask for them

Everything above reads *metadata*. Turn on `polarsense.values.enable` and one more
position starts answering — the other side of a comparison, where what belongs is
data:

```python
df = pl.scan_parquet("data/sales.parquet")
df.filter(pl.col("region") == "␣")     # US, EU, APAC — read out of the file
df.filter(region="␣")                  # the same, on a constraint keyword
df.filter(pl.col("region").is_in(["␣"]))
```

This is the only feature here that reads the rows of your data file, which is why
it is off until you turn it on — from settings, or with *PolarSense: Turn on value
completion* in the command palette. It reads one column of the first
`values.maxRows` rows — parquet is columnar, so that is one column chunk rather
than a scan — and caches the answer against the file's mtime like a schema.

It stays quiet more often than it speaks, on purpose:

- More than `values.maxDistinct` distinct values (50) offers **nothing**, not a
  truncated list. A hundred of four million order ids is a claim about how many
  there are, and a false one.
- Columns whose values aren't strings offer nothing — a value position is always
  inside quotes, where a number would be the wrong literal.
- A read that didn't cover every row marks each item `value (sampled)` and says
  how many rows it saw.
- Hive partition columns are exact and free: `region=EU/`, `region=US/` *are* the
  values, read from the directory names with no data touched at all.

Values are never typo-checked and never hovered. They're data; the file has no
opinion about which of them you meant to type.

And the same wherever pandas or duckdb expects one:

- `groupby`, `sort_values`, `set_index`, `merge`, `drop(columns=…)`,
  `rename(columns={…})`, `astype`, `dropna(subset=…)`, `drop_duplicates`,
  `nlargest`, `value_counts`, `pivot_table`, `query`
- duckdb's relational API — `project`, `order`, `aggregate` — on a relation from
  `duckdb.read_parquet(…)` or from SQL:

```python
import duckdb

rel = duckdb.sql("SELECT * FROM 'data/sales.parquet'")
rel.project("␣")             # completes, and the path in the SQL is ctrl-clickable

df = rel.df().groupby("␣")   # a duckdb relation converted to pandas keeps its schema
```

Column names complete inside the SQL too, in duckdb and in polars:

```python
df.sql("SELECT ␣ FROM self")                        # the frame it was called on
pl.sql("SELECT ␣ FROM df")                          # a frame named in the file
pl.SQLContext(sales=df).execute("SELECT ␣ FROM sales")
duckdb.sql("SELECT s.␣ FROM 'sales.parquet' s")     # an alias picks its table
```

The statement is scanned, not parsed: literals and comments are masked out, then
whatever follows `FROM` and `JOIN` is a table. So `con.execute("SELECT * FROM
users")` names no file and stays quiet, a table name or a quoted path offers
nothing, and a join offers both sides' columns marked as a guess — which side a
bare name belongs to is not something this can know.

Column names are propagated through transformations, so what you are offered is
what actually exists at that point in the chain:

```python
narrow = df.select("region", "revenue").rename({"revenue": "rev"})
narrow.select("␣")           # region, rev — not the other seven columns

joined = a.join(b, on="region")
joined.select("␣")           # both frames' columns, collisions suffixed _right

df.group_by("region").agg(pl.col("revenue").sum()).select("␣")   # region, revenue

df.select(cs.numeric()).select("␣")          # revenue, units — the numeric ones
df.select(cs.starts_with("re")).select("␣")  # region, revenue
```

Selectors narrow rather than stopping the analysis: `cs.numeric()`, `cs.string()`,
`cs.temporal()` and the other dtype groups are matched against the dtypes already
read from the file, the name-based selectors against the names, and `|`, `&`, `-`
and `^` compose two selectors the way polars composes them.

The status bar shows how many columns the frame at the cursor has. Clicking it —
or **PolarSense: Show schema** — lists them with their dtype and statistics, and
picking one writes it at the cursor:

```
sales.parquet · 7 columns
  region       str    min APAC · max US · no nulls
  revenue      f64    min 12.5 · max 9930.0 · 3 nulls
  order_date   date   min 2026-01-02 · max 2026-06-30 · no nulls
```

Hover a column name for its dtype, the file it comes from, and whatever statistics
that file records — for parquet, null count, min and max, read from the same footer
as the schema:

> **region** · `str`
>
> min `APAC` · max `US` · no nulls
>
> _data/sales.parquet · 3 rows_

Column names that do not exist are flagged as you type, with a one-click fix:

```python
df.select("regoin")
#          ~~~~~~   No column "regoin" in this frame. Did you mean "region"?
```

The check only speaks when it is sure. If anything between the file and the cursor
could not be modelled — an unmodelled reshape, a selector it cannot read, a frame
it could not identify, a file it could not read — it stays silent rather than
guessing. A diagnostic that cries wolf gets switched off and never switched back
on. It also stays silent inside `cs.starts_with("reg")` and its siblings, where
the string is a fragment of a name and was never meant to be a whole one.

A frame built in another file is followed too — the import is resolved and that
file is read the same way:

```python
# loaders.py
def load_sales():
    return pl.scan_parquet("data/sales.parquet").select("region", "revenue")

# report.py
from loaders import load_sales
load_sales().select("␣")     # region, revenue — the narrowing survives the import
```

`import loaders` with `loaders.sales`, relative imports, packages and aliases all
work. Only modules the open file actually imports are read, two hops out — nothing
in `site-packages`, and nothing indexed in the background. A function returning a
frame resolves the same way inside a single file. Turn it off with
`polarsense.followImports`.

When a path genuinely cannot be read — it arrives as a function parameter, a
config attribute, an environment variable — a comment can name it:

```python
# polarsense: data/sales.parquet
return pl.scan_parquet(cfg.source_path)

def report(df):        # polarsense: data/sales.parquet
    df.select("␣")     # completes
```

The comment governs the statement it is attached to, trailing on the line or alone
on the line above, and on a `def` it answers for that function's parameters. It is
consulted last, so a path the extension can work out for itself always wins and a
stale pragma cannot override working code. The format comes from the extension —
a bare directory is read as parquet, and Delta or Iceberg tables say so outright:
`# polarsense: delta data/warehouse/sales`.

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
| Parquet | Footer only — two range reads, independent of file size; struct columns keep their fields |
| CSV | Header row, honouring `separator`, `has_header`, `skip_rows`, `comment_prefix`, `quote_char`, `new_columns` |
| Arrow IPC | The schema flatbuffer — out of the footer for a file, out of the first message for a stream; struct columns keep their fields |
| Delta | `_delta_log` walked newest-first to the most recent `metaData` action, falling back to the checkpoint parquet when the commits have been vacuumed |
| Iceberg | `metadata/version-hint.text` → the current schema in that metadata file |

Values — when `values.enable` is on — come from parquet only, plus hive partition
directory names.

Schemas are read when a file opens rather than when you first ask for a column, so
the first completion is a cache hit. They are cached on the file's mtime and size,
and a rewritten file invalidates itself.

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
| `polarsense.followImports` | `true` | Follow imports into other files in the workspace |
| `polarsense.https.enabled` | `false` | Allow reading schemas over `https://` |
| `polarsense.cacheSize` | `200` | File schemas held in memory |
| `polarsense.values.enable` | `false` | Offer real values from your data. **Reads rows, not just metadata** |
| `polarsense.values.maxRows` | `10000` | Rows of one column to read when offering values |
| `polarsense.values.maxDistinct` | `50` | Above this many distinct values, offer none |
| `polarsense.diagnostics.enable` | `true` | Warn about column names that don't exist |
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
  sort below certain answers and say so in the tooltip — and the unknown-column
  warning goes quiet entirely.
- **A warning means the file on disk disagrees with the code**, which is usually
  a typo but occasionally means the data is older than the script that writes it.
  That is why it is a warning rather than an error: polars has the last word.
- **SQL is scanned, not parsed.** Every table in a statement is in scope
  everywhere in it, so a subquery's tables leak outward and a join cannot say
  which side a bare column came from — it offers both, marked uncertain. SQL
  positions are never typo-checked for the same reason.
- **pyarrow is not supported.** Its `read_table` means parquet where pandas' means
  CSV, and telling those apart needs to know which module the call came from.
- **Some selectors are still opaque.** `cs.by_dtype(pl.Int64)`, a selector method
  we do not model, and a dtype selector over a source whose dtypes were never read
  — a CSV with `inferDtypes` off — all widen rather than narrow, and are marked
  uncertain. Bare regex patterns like `"^total_.*$"` in a `select` and computed
  names do the same.
- **Imports are followed two hops, not indefinitely.** A frame three modules
  away, or one whose module lives outside the workspace, still gets nothing —
  and only module-level `def`s are read, so `Loader().load()` needs an instance
  this analysis cannot follow.
- **Frames from function parameters or config objects need to be told.** A type
  annotation carries no path, so `def load(source): return pl.scan_parquet(source)`
  finds the frame but not the file — that is what the pragma comment is for.
- **Multi-file globs assume one schema.** First match wins.
- **Feather V1 is not read.** `.feather` written by old pandas or R is a
  different format that happens to share the extension; polars writes and reads
  Arrow IPC, which is what this understands. A V1 file reports nothing rather
  than misreading its bytes.
- **Object storage is not supported.** `s3://` and `gs://` resolve to nothing and
  stay quiet. `https://` works when enabled.
- **Dtype names are our translation**, not polars' own, so nested and
  timezone-aware types may read slightly differently than `print(df.schema)`.
- **Notebook order is document order.** Cells run out of order resolve as if they
  hadn't been.
- **A parquet page compressed with brotli or LZ4 reports nothing.** Two things
  decompress a page rather than reading a footer — value completion and the Delta
  checkpoint fallback — and between hyparquet's snappy and `fzstd`, those two are
  what is left over.
- **Values are parquet only.** Delta and Iceberg would mean finding their data
  files first, and Arrow IPC would mean decoding its buffers. A column renamed
  between the file and the cursor has no values either: the file has never heard
  of the new name, and matching it back would be guesswork.

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
