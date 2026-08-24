"""Generate the test fixtures: a parquet file, a CSV, a Delta table and an Iceberg
table, plus a JSON dump of the schema each reader is expected to produce.

Run with:  npm run fixtures
Only polars is required; the Delta and Iceberg fixtures are written by hand so the
test suite does not depend on deltalake/pyiceberg being installed.
"""
from __future__ import annotations

import datetime as dt
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
    write_delta()
    write_iceberg()
    write_perf()
    write_expected(df)
    print(f"fixtures written to {DATA}")
    print(df.schema)


if __name__ == "__main__":
    main()
