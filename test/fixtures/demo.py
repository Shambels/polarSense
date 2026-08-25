import polars as pl

df = pl.scan_parquet("data/sales.parquet")

out = df.select(pl.col(""))

top = df.group_by("").agg(pl.col(""))

# --- unknown columns are flagged, with a quick fix (Cmd+.) ---------------------
typo = df.select("regoin")               # <- warned: did you mean "region"?
gone = df.select("region").sort("units")  # <- warned: units was dropped upstream
fine = df.select("region").sort("region") # <- no warning

# --- subscripts and get_column are column sites too ----------------------------
series = df[""]                          # <- completes, hovers, typo-checked
picked = df.get_column("")               # <- same
pair   = df[["", ""]]                    # <- list form works
cfg    = {"path": "data/sales.parquet"}
never  = cfg[""]                         # <- a dict: deliberately offers nothing
