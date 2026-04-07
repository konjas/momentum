#!/usr/bin/env python3
"""Run this inside Docker to find valid strategy codes: docker exec <ctr> python3 /app/src/probe_strat.py"""
import sys, inspect

try:
    import justetf_scraping
except ImportError as e:
    print("NOT INSTALLED:", e); sys.exit(1)

sig = inspect.signature(justetf_scraping.load_overview)
print("SIGNATURE:", sig)

try:
    src = inspect.getsource(justetf_scraping.load_overview)
    print("\n--- SOURCE ---")
    print(src[:3000])
except Exception as e:
    print("no source:", e)

# Try each known JustETF strategy URL param
candidates = [
    None,
    "epg-longOnly", "epg-activeETF", "epg-leveraged", "epg-short", "epg-moneyMarket",
    "long-only", "active", "leveraged", "short", "money-market",
    "activeETF", "moneyMarket",
    "Long-Only", "Active ETF", "Leveraged", "Short", "Money Market",
]
print("\n--- TESTING STRATEGIES ---")
for c in candidates:
    try:
        if c is None:
            df = justetf_scraping.load_overview()
        else:
            df = justetf_scraping.load_overview(strategy=c)
        print(f"  OK  strategy={c!r:30s}  rows={len(df)}")
        break  # stop after first success to see the pattern
    except (KeyError, ValueError, TypeError) as e:
        print(f"  ERR strategy={c!r:30s}  → {type(e).__name__}: {e}")
    except Exception as e:
        print(f"  EXC strategy={c!r:30s}  → {type(e).__name__}: {str(e)[:60]}")
