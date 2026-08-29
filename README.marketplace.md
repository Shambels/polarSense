# PolarSense

![Demo GIF](assets/demo.gif)

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
footer, a Delta commit log, an Iceberg metadata pointer, an xlsx header row.
PolarSense reads it and offers the names.

It never imports polars, never spawns a Python interpreter, and never runs your
code. It reads bytes out of your data files and nothing else — and by default only
the metadata part of them.

Open a `.parquet` file and you see the data rather than a binary-file notice — the
same viewer, with no code around it.

## Completion, wherever a column name goes

Inside the string literals polars, pandas and duckdb expect a column in:
`pl.col`, `select`, `with_columns`, `filter`, `group_by`, `agg`, `sort`, `join`
(including `right_on=`, which completes from the frame being joined in),
`rename` and `cast` dict keys, `over`, `pivot`, `unpivot`, `df["region"]`,
`polars.selectors`, and struct fields as deep as they go. On the pandas side
`groupby`, `sort_values`, `merge`, `astype`, `query` and the rest; on the duckdb
side the relational API.

Column names complete inside SQL too:

```python
df.sql("SELECT ␣ FROM self")
pl.sql("SELECT ␣ FROM df")
duckdb.sql("SELECT s.␣ FROM 'sales.parquet' s")
```

## It follows the chain

What you are offered is what exists at that point, not what the file started with:

```python
narrow = df.select("region", "revenue").rename({"revenue": "rev"})
narrow.select("␣")           # region, rev — not the other seven columns

joined = a.join(b, on="region")
joined.select("␣")           # both frames' columns, collisions suffixed _right

df.group_by("region").agg(pl.col("revenue").sum()).select("␣")   # region, revenue

df.select(cs.numeric()).select("␣")   # revenue, units — the numeric ones
df.unnest("address").select("␣")      # the struct's fields, in its place
```

Frames built in another file work too — the import is resolved and that file is
read the same way, so a loader function's narrowing survives the import. Paths
don't have to be literals either: module constants, f-strings, `Path(...) / "f.parquet"`,
`os.path.join(...)` and `Path(__file__).parent` all fold down to a path first.

When a path genuinely can't be read — it arrives as a function parameter, a config
attribute, an environment variable — a comment names it:

```python
# polarsense: data/sales.parquet
return pl.scan_parquet(cfg.source_path)
```

## It catches typos

```python
df.select("regoin")
#          ~~~~~~   No column "regoin" in this frame. Did you mean "region"?
```

One click to fix. The check only speaks when it is sure: if anything between the
file and the cursor couldn't be modelled, it stays quiet rather than guessing. A
diagnostic that cries wolf gets switched off and never switched back on.

## Hover, status bar, schema

The status bar shows how many columns the frame at your cursor has. Clicking it —
or **PolarSense: Show schema** — lists them with dtype and statistics, and picking
one writes it at the cursor. Hovering a column name gives you the same for one:

> **region** · `str`
>
> min `APAC` · max `US` · no nulls
>
> _data/sales.parquet · 3 rows_

## Three panels beside your code

**PolarSense: Show details** — a row per column, with the numbers the file's own
metadata carries:

```
sales.parquet · df
1,048,576 rows · 9 columns · 24.1 MB · 8 row groups · zstd

Column       Type   Nulls   Min         Max
region       str    0       APAC        US
revenue      f64    3       12.5        9930.0
order_date   date   0       2026-01-02  2026-06-30
```

It reads nothing the completions haven't already read, so it opens on a
four-million-row file as fast as on a small one.

**PolarSense: Show data (reads rows)** opens the file itself, a hundred rows at a
time, header and row index pinned. The page on screen is the read: only those rows
and only the columns being drawn are fetched.

**PolarSense: Show graph (reads rows)** draws the shape of a column instead of
listing it — a histogram, a bar of counts, a line over a date, a scatter — picked
by dtype, with the aggregate (`count`, `sum`, `mean`, `median`, `min`, `max`) and
the chart type a click away, and a date `by` picker for year/month/week/day. The
rows never reach the panel: bins are counted in the extension, so a histogram of
four million rows is thirty numbers. A download button writes the chart to a PNG at
twice its drawn size, on the panel's own background.

In a notebook, all three are a click away from the output itself:

```
   shape: (200, 4)
   ┌────────┬──────────┬─────────┐
   │ region ┆ order_id ┆ revenue │
   └────────┴──────────┴─────────┘

   POLARSENSE  [ Details ]  [ Data ]  [ Graph ]
```

No kernel needed to find the frame — the buttons work on a notebook you've opened
but never run, on a frame defined eight cells earlier.

## Or just open the file

A `.parquet` file opens as its own tab: the same paginated grid, no Python
anywhere near it, and *Details* and *Graph* buttons in its bar.

```
sales.parquet
1,048,576 rows · 9 columns · 24.1 MB · 8 row groups · zstd

‹ rows  rows ›   rows 0–99 of 1,048,576   ‹ columns  columns ›   [filter]  [Details] [Graph]
```

The page on screen is still the whole read — a four-million-row file opens as fast
as a small one — and the tab redraws itself when a script rewrites the file under
it. It is a read-only editor with no save path at all. `View: Reopen Editor With…`
gets VS Code's own editor back.

## Values, if you ask for them

Everything above reads *metadata*. Turn on `polarsense.values.enable` and the
positions holding a **value** of a column start answering too:

```python
df.filter(pl.col("region") == "␣")     # US, EU, APAC — read out of the file
df.filter(region="␣")
df.filter(pl.col("region").is_in(["␣"]))
```

This is the only feature that reads the rows of your data file, which is why it is
off until you turn it on. It stays quiet on purpose more often than it speaks:
more than 50 distinct values offers **nothing** rather than a truncated list, and
non-string columns offer nothing, because a value position is always inside quotes.
Hive partition columns are exact and free — `region=EU/` *is* the value.

## Formats

| Format | How the schema is read |
| --- | --- |
| Parquet | Footer only — two range reads, independent of file size |
| CSV | Header row, honouring `separator`, `has_header`, `skip_rows`, `comment_prefix`, `quote_char` |
| Arrow IPC | The schema flatbuffer, from the footer or the first message |
| Delta | `_delta_log` walked newest-first, with a checkpoint fallback |
| Iceberg | `version-hint.text` → the current schema |
| JSON / NDJSON | The first 50 objects of a bounded prefix; nested objects keep their fields |
| Excel | The header row, out of the `.xlsx` zip |

Rows and graphs come from parquet and CSV; values from parquet plus hive
partition names. Schemas are read when a file opens rather than when you first ask,
so the first completion is a cache hit, and a rewritten file invalidates itself.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `polarsense.enable` | `true` | Turn completions off without uninstalling |
| `polarsense.pathRoots` | `[]` | Extra directories to try for relative paths |
| `polarsense.followImports` | `true` | Follow imports into other files in the workspace |
| `polarsense.csv.inferDtypes` | `false` | Guess CSV dtypes from the first rows |
| `polarsense.https.enabled` | `false` | Allow reading schemas over `https://` |
| `polarsense.values.enable` | `false` | Offer real values from your data. **Reads rows, not just metadata** |
| `polarsense.graph.maxRows` | `100000` | Rows to read when drawing a graph |
| `polarsense.diagnostics.enable` | `true` | Warn about column names that don't exist |
| `polarsense.notebook.buttons` | `true` | Show the Details / Data / Graph buttons under a frame |
| `polarsense.trace` | `false` | Log every resolution to the PolarSense output channel |

The full table — caps, cache size, sniff bytes, the kernel setting — is in the
[README on GitHub](README.md).

### If nothing appears

VS Code suppresses quick suggestions inside strings by default. PolarSense ships a
default that turns them on for Python, but a setting of your own takes precedence:

```jsonc
"[python]": { "editor.quickSuggestions": { "strings": "on" } }
```

<kbd>Ctrl</kbd>+<kbd>Space</kbd> always works regardless. The status bar shows what
the frame at your cursor resolved to, or why it didn't; **PolarSense: Show log** has
the detail, and that is what to attach to a bug report.

## What it deliberately doesn't do

Say nothing rather than something wrong is the rule the whole extension is built
on. Where it cannot be sure it marks the answer as a guess, sorts it lower, and
switches the typo warning off entirely.

- **Reshapes that invent names from data** — `pivot`, `to_dummies`, a bare
  `transpose` — cannot be answered without reading the rows, so they keep the
  columns already known and drop certainty.
- **SQL is scanned, not parsed**, so a join offers both sides' columns and SQL
  positions are never typo-checked.
- **The details and data panels describe the source file**, not the filtered
  frame; they say `transforms not applied` rather than quietly showing you four
  million rows and calling it the frame.
- **Imports are followed two hops**, within the workspace only — nothing in
  `site-packages`, nothing indexed in the background.
- **`s3://` and `gs://` resolve to nothing**; `https://` works when enabled.
- **`.xls` and Feather V1 are not read** — different binary formats wearing
  familiar extensions. They report nothing rather than guessing at their bytes.
- **The parquet viewer views** — it pages, steps columns and filters the column
  list. No sorting, no row filter, no editing: sorting a page means scanning the
  file, which is a different product.
- **pyarrow is not supported.**

## Privacy

No telemetry. Nothing leaves your machine except the byte ranges of the data files
you point it at, and only over `https://` if you turn that on.

Source, full documentation and issues: [github.com/Shambels/polarSense](https://github.com/Shambels/polarSense).
MIT licensed.
