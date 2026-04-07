#!/usr/bin/env python3
"""
probe_etf.py TICKER_OR_ISIN

Pokaż surowe dane biblioteki justetf_scraping dla jednego ETFa.
Użycie:
  docker exec justetf-momentum python3 /app/src/probe_etf.py JEDI
  docker exec justetf-momentum python3 /app/src/probe_etf.py IE00BMVB5P51
"""
import sys, json
import pandas as pd

try:
    import justetf_scraping
except ImportError as e:
    print(f"Brak justetf_scraping: {e}"); sys.exit(1)

query = sys.argv[1].strip().upper() if len(sys.argv) > 1 else ''
if not query:
    print("Użycie: probe_etf.py TICKER_LUB_ISIN"); sys.exit(1)

df = justetf_scraping.load_overview(enrich=True).reset_index()

# Szukaj po ISIN (index), tickerze lub nazwie
mask = (
    df.get('isin', pd.Series(dtype=str)).str.upper().eq(query) |
    df.get('ticker', pd.Series(dtype=str)).str.upper().eq(query) |
    df.get('wkn', pd.Series(dtype=str)).str.upper().eq(query) |
    df.get('name', pd.Series(dtype=str)).str.upper().str.contains(query, na=False)
)
row = df[mask]

if row.empty:
    print(f"Nie znaleziono ETFa dla zapytania: {query}"); sys.exit(1)

cols = [
    'name', 'currency', 'domicile_country', 'asset_class', 'instrument',
    'strategy', 'dividends', 'ter', 'size',
    'last_month', 'last_three_months', 'last_six_months', 'last_year',
    'last_year_volatility', 'exchange',
]
available = [c for c in cols if c in df.columns]
print(row[available].to_string())
print()
print("--- Wszystkie kolumny ---")
for _, r in row.iterrows():
    for k, v in r.items():
        if pd.notna(v) and v != '':
            print(f"  {k}: {v}")
