"""Open this file in the Extension Development Host (F5) and type inside the
strings marked below. Every completion here comes from a real file in ./data.

Run `npm run fixtures` first if ./data is empty.
"""

import os
from pathlib import Path

import polars as pl

DATA = Path("data")

# --- parquet, the common case ---------------------------------------------
df = pl.scan_parquet("data/sales.parquet")

out = df.select(pl.col(""))  # <- type here
ranked = df.sort(by="")  # <- and here
grouped = df.group_by("").agg(pl.col(""))

# --- the frame is tracked through aliases and chains ----------------------
recent = df.filter(pl.col("revenue") > 100)
narrow = recent.drop("")  # <- still sales.parquet

# --- paths do not have to be literals -------------------------------------
from_const = pl.scan_parquet(DATA / "sales.parquet")
from_const.select("")

from_join = pl.read_parquet(os.path.join("data", "sales.parquet"))
from_join.unique(subset=[""])

# --- CSV: the header row is the schema ------------------------------------
csv = pl.read_csv("data/sales.csv")
csv.select("")

semi = pl.read_csv("data/sales_semi.csv", separator=";")
semi.select("")  # <- same columns, different separator

# --- join: left and right complete from different frames ------------------
left = pl.scan_parquet("data/sales.parquet")
right = pl.read_csv("data/sales.csv")
joined = left.join(right, left_on="", right_on="")

# --- table formats --------------------------------------------------------
delta = pl.scan_delta("data/delta_sales")
delta.select("")

iceberg = pl.scan_iceberg("data/iceberg_sales")
iceberg.select("")

# --- hive partitions appear alongside the file's own columns --------------
hive = pl.scan_parquet("data/hive")
hive.select("")  # <- includes `region`

# --- and the positions that should stay quiet -----------------------------
renamed = df.rename({"region": ""})  # <- value is a NEW name: no completions
labelled = df.select(pl.col("region").alias(""))  # <- also a new name
print("")  # <- not polars at all

# --- JSON and NDJSON: dtypes come from the values themselves --------------
nd = pl.scan_ndjson("data/sales.ndjson")
nd.select("")  # <- `late_key` is here too: keys are unioned across rows

nested = pl.read_json("data/nested.ndjson")
nested.select(pl.col("address").struct.field(""))  # <- city, geo

# --- Excel: the tab, not the part number ----------------------------------
excel = pl.read_excel("data/sales.xlsx")
excel.select("")  # <- gaps in the header row are named, not closed up

q2 = pl.read_excel("data/sheets.xlsx", sheet_name="Q2")
q2.select("")  # <- q2_col, though Q2 is stored in sheet1.xml

first = pl.read_excel("data/sheets.xlsx")
first.select("")  # <- summary_col: the first *tab*, stored in sheet3.xml
