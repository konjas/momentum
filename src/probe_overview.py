#!/usr/bin/env python3
"""
Probe script - run inside Docker:
  docker exec <container> python3 /app/src/probe_overview.py
"""
import sys, json
import pandas as pd

try:
    import justetf_scraping
except ImportError as e:
    print(f"NOT INSTALLED: {e}"); sys.exit(1)

# ── 1. Plain load_overview ─────────────────────────────────────────────────
print("=== load_overview() ===", flush=True)
try:
    df = justetf_scraping.load_overview()
    print(f"Rows: {len(df)}")
    print(f"Columns: {df.columns.tolist()}")
    if 'strategy' in df.columns:
        print(f"Strategy values: {df['strategy'].value_counts().to_dict()}")
    print()
except Exception as e:
    print(f"ERROR: {e}")

# ── 2. Enriched load_overview ──────────────────────────────────────────────
print("=== load_overview(enrich=True) ===", flush=True)
try:
    df2 = justetf_scraping.load_overview(enrich=True)
    print(f"Rows: {len(df2)}")
    print(f"Columns ({len(df2.columns)}): {df2.columns.tolist()}")
    print()

    # Print first ETF as pretty JSON
    row = df2.iloc[0]
    data = {}
    for col in df2.columns:
        v = row[col]
        try:
            if pd.isna(v): v = None
        except: pass
        if hasattr(v, 'item'): v = v.item()
        data[col] = v
    print("=== FIRST ETF (enriched) ===")
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))

    # Show unique values of categorical-looking columns
    print("\n=== CATEGORICAL COLUMNS ===")
    for col in df2.columns:
        unique = df2[col].dropna().unique()
        if 1 < len(unique) <= 30:
            print(f"  {col}: {sorted(str(x) for x in unique)}")
except Exception as e:
    import traceback
    print(f"ERROR: {e}")
    traceback.print_exc()
