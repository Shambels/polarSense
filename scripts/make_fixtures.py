"""Generate the test fixtures: a parquet file, a CSV, a pair of Arrow IPC files, a
Delta table and an Iceberg table, plus a JSON dump of the schema each reader is
expected to produce.

Run with:  npm run fixtures
Only polars is required; the Delta and Iceberg fixtures are written by hand so the
test suite does not depend on deltalake/pyiceberg being installed.
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import pathlib

import polars as pl

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "test" / "fixtures"
DATA = OUT / "data"


def build_frame() -> pl.DataFrame:
    return pl.DataFrame(
        {
            "region": ["EU", "US", "APAC"],
            "revenue": [1.5, 2.25, 3.0],
            "returns_qty": pl.Series([1, 2, 3], dtype=pl.Int32),
            "units": pl.Series([10, 20, 30], dtype=pl.Int64),
            "is_active": [True, False, True],
            "order_date": [dt.date(2026, 1, 1), dt.date(2026, 2, 1), dt.date(2026, 3, 1)],
            "created_at": [
                dt.datetime(2026, 1, 1, 12, 0),
                dt.datetime(2026, 2, 1, 12, 0),
                dt.datetime(2026, 3, 1, 12, 0),
            ],
            "notes": ["a", None, "c"],
            "tags": [["x", "y"], ["z"], []],
        }
    )


def write_parquet(df: pl.DataFrame) -> None:
    df.write_parquet(DATA / "sales.parquet")
    # A hive-partitioned tree, to exercise partition-column discovery.
    for region in ("EU", "US"):
        part = DATA / "hive" / f"region={region}"
        part.mkdir(parents=True, exist_ok=True)
        df.drop("region").write_parquet(part / "part-0.parquet")


def write_csv(df: pl.DataFrame) -> None:
    df.drop("tags").write_csv(DATA / "sales.csv")
    df.drop("tags").write_csv(DATA / "sales_semi.csv", separator=";")
    headerless = DATA / "headerless.csv"
    headerless.write_text("EU,1.5,10\nUS,2.25,20\n", encoding="utf-8")
    commented = DATA / "commented.csv"
    commented.write_text("# generated\n# by hand\nregion,revenue\nEU,1.5\n", encoding="utf-8")
    quoted = DATA / "quoted.csv"
    quoted.write_text('"region, long name",revenue\n"EU, west",1.5\n', encoding="utf-8")


def write_nested() -> None:
    """A struct column, and a struct inside it, for `.struct.field(…)`.

    Kept apart from the main frame so the reader corpus above stays a flat
    schema — the point here is the tree, not another column of it.
    """
    frame = pl.DataFrame(
        {
            "id": [1, 2],
            "address": [
                {"city": "Ghent", "postcode": "9000", "geo": {"lat": 51.05, "lon": 3.72}},
                {"city": "Lisbon", "postcode": "1100", "geo": {"lat": 38.72, "lon": -9.14}},
            ],
            "tags": [["a", "b"], ["c"]],
        },
        schema={
            "id": pl.Int64,
            "address": pl.Struct(
                [
                    pl.Field("city", pl.String),
                    pl.Field("postcode", pl.String),
                    pl.Field(
                        "geo",
                        pl.Struct([pl.Field("lat", pl.Float64), pl.Field("lon", pl.Float64)]),
                    ),
                ]
            ),
            "tags": pl.List(pl.String),
        },
    )
    # Named so it still sorts after sales.parquet: the glob corpus asserts which
    # file a `*.parquet` pattern lands on, and that is the first one by name.
    frame.write_parquet(DATA / "structs.parquet")


def write_ipc(df: pl.DataFrame) -> None:
    """The same frame in Arrow IPC, in both the file and the stream shape.

    `arrow_types.arrow` is the type corners in one place: what polars actually
    writes is view types, large lists and a dictionary-encoded categorical, none
    of which the parquet fixtures exercise.
    """
    df.write_ipc(DATA / "sales.arrow")
    df.write_ipc_stream(DATA / "sales_stream.arrow")

    pl.DataFrame(
        {
            "id": [1, 2],
            "address": [
                {"city": "Ghent", "postcode": "9000", "geo": {"lat": 51.05, "lon": 3.72}},
                {"city": "Lisbon", "postcode": "1100", "geo": {"lat": 38.72, "lon": -9.14}},
            ],
            "tags": [["a", "b"], ["c"]],
            "grade": ["gold", "silver"],
            "price": [decimal.Decimal("1.50"), decimal.Decimal("2.25")],
            "opened_at": [dt.time(9, 0), dt.time(17, 30)],
            "elapsed": [dt.timedelta(seconds=1), dt.timedelta(seconds=2)],
            "hits": pl.Series([1, 2], dtype=pl.UInt32),
            "ratio": pl.Series([0.5, 0.25], dtype=pl.Float32),
            "blob": pl.Series([b"\x00", b"\x01"], dtype=pl.Binary),
            "point": pl.Series([[1.0, 2.0], [3.0, 4.0]], dtype=pl.Array(pl.Float64, 2)),
            "utc_at": pl.Series(
                [dt.datetime(2026, 1, 1, 12, 0), dt.datetime(2026, 2, 1, 12, 0)]
            ).dt.replace_time_zone("UTC"),
        },
        schema={
            "id": pl.Int64,
            "address": pl.Struct(
                [
                    pl.Field("city", pl.String),
                    pl.Field("postcode", pl.String),
                    pl.Field(
                        "geo",
                        pl.Struct([pl.Field("lat", pl.Float64), pl.Field("lon", pl.Float64)]),
                    ),
                ]
            ),
            "tags": pl.List(pl.String),
            "grade": pl.Categorical,
            "price": pl.Decimal(18, 2),
            "opened_at": pl.Time,
            "elapsed": pl.Duration("us"),
            "hits": pl.UInt32,
            "ratio": pl.Float32,
            "blob": pl.Binary,
            "point": pl.Array(pl.Float64, 2),
            "utc_at": pl.Datetime("us", "UTC"),
        },
    ).write_ipc(DATA / "arrow_types.arrow")


def write_values() -> None:
    """A frame built for value completion, and for its silences.

    `region` has three values in deliberately uneven counts, so the offer being
    in frequency order is distinguishable from alphabetical and from first-seen.
    `order_id` has two hundred, which is over any sensible cap. `revenue` is not
    a string and `empty` is nothing but nulls: both are cases where the answer
    has to be no answer.
    """
    n = 200
    pl.DataFrame(
        {
            "region": ["APAC"] * 40 + ["EU"] * 60 + ["US"] * 100,
            "order_id": [f"ord-{i:04d}" for i in range(n)],
            "revenue": [float(i) for i in range(n)],
            "empty": pl.Series([None] * n, dtype=pl.String),
        }
    ).write_parquet(DATA / "values.parquet")


def write_delta() -> None:
    """A minimal but protocol-shaped _delta_log."""
    table = DATA / "delta_sales"
    log = table / "_delta_log"
    log.mkdir(parents=True, exist_ok=True)
    schema = {
        "type": "struct",
        "fields": [
            {"name": "region", "type": "string", "nullable": True, "metadata": {}},
            {"name": "revenue", "type": "double", "nullable": True, "metadata": {}},
            {"name": "units", "type": "long", "nullable": True, "metadata": {}},
            {"name": "opened_at", "type": "timestamp", "nullable": True, "metadata": {}},
            {"name": "price", "type": "decimal(18,2)", "nullable": True, "metadata": {}},
            {
                "name": "tags",
                "type": {"type": "array", "elementType": "string", "containsNull": True},
                "nullable": True,
                "metadata": {},
            },
        ],
    }
    commit0 = [
        {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}},
        {
            "metaData": {
                "id": "f1b3f4a0-0000-4000-8000-000000000000",
                "format": {"provider": "parquet", "options": {}},
                "schemaString": json.dumps(schema),
                "partitionColumns": ["region"],
                "configuration": {},
                "createdTime": 1_767_000_000_000,
            }
        },
    ]
    # A later commit with no metaData, so the reader must walk backwards past it.
    commit1 = [{"add": {"path": "region=EU/part-0.parquet", "size": 1, "dataChange": True}}]
    (log / "00000000000000000000.json").write_text(
        "\n".join(json.dumps(a) for a in commit0) + "\n", encoding="utf-8"
    )
    (log / "00000000000000000001.json").write_text(
        "\n".join(json.dumps(a) for a in commit1) + "\n", encoding="utf-8"
    )


def write_delta_checkpoint() -> None:
    """A table whose JSON commits have been vacuumed: only a checkpoint is left.

    The metaData action sits at row 1, not row 0, so the reader has to find it
    rather than assume it. Snappy, not the polars default, because that is what
    Spark and delta-rs write and it is what hyparquet can decompress.
    """
    log = DATA / "delta_checkpoint" / "_delta_log"
    log.mkdir(parents=True, exist_ok=True)
    schema = {
        "type": "struct",
        "fields": [
            {"name": "region", "type": "string", "nullable": True, "metadata": {}},
            {"name": "revenue", "type": "double", "nullable": True, "metadata": {}},
            {"name": "checkpointed_at", "type": "timestamp", "nullable": True, "metadata": {}},
        ],
    }
    meta = pl.Struct(
        [
            pl.Field("id", pl.String),
            pl.Field("schemaString", pl.String),
            pl.Field("createdTime", pl.Int64),
        ]
    )
    add = pl.Struct([pl.Field("path", pl.String), pl.Field("size", pl.Int64)])
    actions = pl.DataFrame(
        {
            "metaData": pl.Series(
                [
                    None,
                    {
                        "id": "c0ffee00-0000-4000-8000-000000000000",
                        "schemaString": json.dumps(schema),
                        "createdTime": 1_767_000_000_000,
                    },
                    None,
                    None,
                ],
                dtype=meta,
            ),
            "add": pl.Series(
                [
                    None,
                    None,
                    {"path": "part-0.parquet", "size": 1},
                    {"path": "part-1.parquet", "size": 2},
                ],
                dtype=add,
            ),
        }
    )
    actions.write_parquet(
        log / "00000000000000000002.checkpoint.parquet", compression="snappy"
    )
    # A commit above the checkpoint carrying no metaData, so the JSON walk runs
    # and comes up empty before the fallback fires.
    (log / "00000000000000000003.json").write_text(
        json.dumps({"add": {"path": "part-2.parquet", "size": 3, "dataChange": True}}) + "\n",
        encoding="utf-8",
    )


def write_delta_checkpoint_zstd() -> None:
    """The same shape, compressed the way polars and modern delta-rs write.

    zstd is polars' default, and reading a page of it is what `fzstd` is in the
    dependency list for. Kept beside the snappy fixture rather than replacing it:
    snappy is what Spark writes, and both have to keep working.
    """
    log = DATA / "delta_checkpoint_zstd" / "_delta_log"
    log.mkdir(parents=True, exist_ok=True)
    schema = {
        "type": "struct",
        "fields": [
            {"name": "region", "type": "string", "nullable": True, "metadata": {}},
            {"name": "zstd_only", "type": "double", "nullable": True, "metadata": {}},
        ],
    }
    meta = pl.Struct(
        [
            pl.Field("id", pl.String),
            pl.Field("schemaString", pl.String),
            pl.Field("createdTime", pl.Int64),
        ]
    )
    add = pl.Struct([pl.Field("path", pl.String), pl.Field("size", pl.Int64)])
    pl.DataFrame(
        {
            "metaData": pl.Series(
                [
                    None,
                    {
                        "id": "z0000000-0000-4000-8000-000000000000",
                        "schemaString": json.dumps(schema),
                        "createdTime": 1_767_000_000_000,
                    },
                    None,
                ],
                dtype=meta,
            ),
            "add": pl.Series(
                [None, None, {"path": "part-0.parquet", "size": 1}], dtype=add
            ),
        }
    ).write_parquet(
        log / "00000000000000000002.checkpoint.parquet", compression="zstd"
    )


def write_iceberg() -> None:
    table = DATA / "iceberg_sales"
    meta = table / "metadata"
    meta.mkdir(parents=True, exist_ok=True)
    schema_v0 = {
        "schema-id": 0,
        "type": "struct",
        "fields": [{"id": 1, "name": "region", "required": True, "type": "string"}],
    }
    schema_v1 = {
        "schema-id": 1,
        "type": "struct",
        "fields": [
            {"id": 1, "name": "region", "required": True, "type": "string"},
            {"id": 2, "name": "revenue", "required": False, "type": "double"},
            {"id": 3, "name": "units", "required": False, "type": "long"},
            {"id": 4, "name": "opened_at", "required": False, "type": "timestamptz"},
            {"id": 5, "name": "price", "required": False, "type": "decimal(18, 2)"},
            {
                "id": 6,
                "name": "tags",
                "required": False,
                "type": {
                    "type": "list",
                    "element-id": 7,
                    "element": "string",
                    "element-required": False,
                },
            },
        ],
    }
    metadata = {
        "format-version": 2,
        "table-uuid": "b1c2d3e4-0000-4000-8000-000000000000",
        "location": str(table),
        "current-schema-id": 1,
        "schemas": [schema_v0, schema_v1],
        "current-snapshot-id": -1,
        "snapshots": [],
    }
    (meta / "v1.metadata.json").write_text(json.dumps({**metadata, "current-schema-id": 0}), encoding="utf-8")
    (meta / "v2.metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (meta / "version-hint.text").write_text("2\n", encoding="utf-8")


def write_perf() -> None:
    """The pathological case the perf guard runs against."""
    wide = pl.DataFrame({f"col_{i:04d}": [float(i)] for i in range(5000)})
    wide.write_parquet(DATA / "wide.parquet")

    lines = ["import polars as pl", 'df = pl.scan_parquet("wide.parquet")']
    for i in range(1000):
        lines.append(f'tmp_{i} = df.filter(pl.col("col_{i:04d}") > {i})')
    lines.append('out = df.select(pl.col(""))')
    (DATA / "big_script.py").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_expected(df: pl.DataFrame) -> None:
    expected = {
        "parquet": [{"name": n, "dtype": str(t)} for n, t in df.schema.items()],
        "csv": [n for n in df.drop("tags").columns],
    }
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2), encoding="utf-8")


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    df = build_frame()
    write_parquet(df)
    write_csv(df)
    write_nested()
    write_ipc(df)
    write_values()
    write_delta()
    write_delta_checkpoint()
    write_delta_checkpoint_zstd()
    write_iceberg()
    write_perf()
    write_expected(df)
    print(f"fixtures written to {DATA}")
    print(df.schema)


if __name__ == "__main__":
    main()
