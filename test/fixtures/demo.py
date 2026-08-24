import polars as pl

df = pl.scan_parquet("data/sales.parquet")

out = df.select(pl.col(""))

top = df.group_by("").agg(pl.col(""))
