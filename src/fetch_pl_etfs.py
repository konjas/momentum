#!/usr/bin/env python3
"""
fetch_pl_etfs.py — Scraper polskich ETF/ETC/ETN
Źródła:
  - GPW XLS      → ticker, ISIN, waluta, instrument
  - AtlasETF     → name, TER, AuM, replication, dividends, strategy, hedged,
                   domicile, asset_class, region, category
  - Stooq        → perf_1m/3m/6m/12m, mdd12m, volatility (w PLN)
  - NBP API      → EUR/PLN (do przeliczenia AuM)
Wynik: NDJSON na stdout (ten sam format co fetch_etfs.py)
"""
import sys, json, math, io, re, os, time, csv, urllib.request, struct
from datetime import datetime, timedelta

try:
    import olefile
except ImportError:
    print(json.dumps({"error": "olefile not installed"}), file=sys.stderr); sys.exit(1)
try:
    import yaml
    YAML_OK = True
except ImportError:
    YAML_OK = False
try:
    from playwright.sync_api import sync_playwright
    PW_OK = True
except ImportError:
    PW_OK = False
    print("[WARN] playwright nie zainstalowany — AtlasETF/Stooq scraping wyłączony", file=sys.stderr)

sys.path.insert(0, os.path.dirname(__file__))
from fetch_etfs import load_group_rules, make_group_key

SOURCE = 'atlasetf'

# ── GPW ───────────────────────────────────────────────────────────────────────
GPW_URLS = {
    'ETF': 'https://www.gpw.pl/etfy?download_xls=1',
    'ETC': 'https://www.gpw.pl/etfy?download_xls=2',
    'ETN': 'https://www.gpw.pl/etfy?download_xls=3',
}

def fetch_gpw_xls(url: str) -> bytes:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def parse_biff8_strings(data: bytes) -> list[str]:
    strings = []
    i = 0
    while i < len(data) - 4:
        rec_type = struct.unpack_from('<H', data, i)[0]
        rec_len  = struct.unpack_from('<H', data, i+2)[0]
        body     = data[i+4:i+4+rec_len]
        if rec_type == 0x00FC:  # SST
            count = struct.unpack_from('<I', body, 4)[0]
            pos = 8
            for _ in range(count):
                if pos >= len(body):
                    break
                nchars = struct.unpack_from('<H', body, pos)[0]
                flags  = body[pos+2] if pos+2 < len(body) else 0
                pos += 3
                compressed = not (flags & 0x01)
                if compressed:
                    s = body[pos:pos+nchars].decode('latin-1', errors='replace')
                    pos += nchars
                else:
                    s = body[pos:pos+nchars*2].decode('utf-16-le', errors='replace')
                    pos += nchars * 2
                strings.append(s)
        i += 4 + rec_len
    return strings

def parse_biff8_rows(data: bytes, strings: list[str]) -> list[list]:
    rows = {}
    i = 0
    while i < len(data) - 4:
        rec_type = struct.unpack_from('<H', data, i)[0]
        rec_len  = struct.unpack_from('<H', data, i+2)[0]
        body     = data[i+4:i+4+rec_len]
        if rec_type == 0x00FD and len(body) >= 6:  # LABELSST
            row = struct.unpack_from('<H', body, 0)[0]
            col = struct.unpack_from('<H', body, 2)[0]
            idx = struct.unpack_from('<I', body, 6)[0]
            val = strings[idx] if idx < len(strings) else ''
            rows.setdefault(row, {})[col] = val
        elif rec_type == 0x0204 and len(body) >= 8:  # LABEL
            row = struct.unpack_from('<H', body, 0)[0]
            col = struct.unpack_from('<H', body, 2)[0]
            nch = struct.unpack_from('<H', body, 6)[0]
            val = body[8:8+nch].decode('latin-1', errors='replace')
            rows.setdefault(row, {})[col] = val
        i += 4 + rec_len
    if not rows:
        return []
    max_row = max(rows.keys())
    max_col = max(max(r.keys()) for r in rows.values())
    return [[rows.get(r, {}).get(c, '') for c in range(max_col+1)] for r in range(max_row+1)]

def parse_gpw_xls(data: bytes, instrument: str) -> list[dict]:
    ole = olefile.OleFileIO(io.BytesIO(data))
    wb_data = ole.openstream('Workbook').read()
    ole.close()
    strings = parse_biff8_strings(wb_data)
    table   = parse_biff8_rows(wb_data, strings)
    results = []
    for i, row in enumerate(table):
        if i == 0:
            continue
        try:
            ticker   = str(row[1]).strip() if len(row) > 1 and row[1] else None
            isin     = str(row[2]).strip() if len(row) > 2 and row[2] else None
            currency = str(row[3]).strip() if len(row) > 3 and row[3] else 'PLN'
        except (IndexError, TypeError):
            continue
        if not isin or len(isin) != 12:
            continue
        results.append({'isin': isin, 'ticker': ticker, 'currency': currency, 'instrument': instrument})
    return results

def fetch_all_gpw() -> list[dict]:
    all_etfs = []
    for instrument, url in GPW_URLS.items():
        try:
            print(f"[GPW] Pobieranie {instrument}...", file=sys.stderr)
            data = fetch_gpw_xls(url)
            rows = parse_gpw_xls(data, instrument)
            print(f"[GPW] {instrument}: {len(rows)} instrumentów", file=sys.stderr)
            all_etfs.extend(rows)
        except Exception as e:
            print(f"[GPW] Błąd {instrument}: {e}", file=sys.stderr)
    return all_etfs

# ── AtlasETF ──────────────────────────────────────────────────────────────────
ATLAS_BASE = 'https://atlasetf.pl/etf-details'

def parse_bool(text: str) -> int:
    return 1 if text and text.strip().lower() in ('tak', 'yes', 'true') else 0

def atlas_strategy(active: str, leveraged: str, inverse: str) -> str:
    if parse_bool(leveraged) or parse_bool(inverse):
        return 'short-leveraged'
    if parse_bool(active):
        return 'active'
    return 'long-only'

def atlas_dividends(policy: str) -> str | None:
    if not policy:
        return None
    p = policy.strip().lower()
    if 'akumul' in p or 'accumul' in p:
        return 'Acc'
    if 'dystryb' in p or 'distrib' in p:
        return 'Dist'
    return policy.strip()

def scrape_atlas_batch(isins: list[str], page) -> dict[str, dict]:
    """Scrapuje AtlasETF używając przekazanej strony Playwright."""
    results = {}
    for isin in isins:
        try:
            url = f"{ATLAS_BASE}/{isin}"
            page.goto(url, wait_until='networkidle')
            data = extract_atlas_page(page, isin)
            results[isin] = data
            print(f"[AtlasETF] {isin}: {data.get('name','?')}", file=sys.stderr)
        except Exception as e:
            print(f"[AtlasETF] Błąd {isin}: {e}", file=sys.stderr)
            results[isin] = {}
        time.sleep(0.5)
    return results

def extract_atlas_page(page, isin: str) -> dict:
    out = {}

    # Nazwa z tytułu strony "Beta ETF mWIG40TR | PLBETF400025"
    try:
        out['name'] = page.title().split('|')[0].strip()
    except Exception:
        out['name'] = isin

    def get_labeled(label: str) -> str | None:
        try:
            els = page.locator(f'*:has-text("{label}")').all()
            for el in els:
                try:
                    txt = el.inner_text(timeout=1000).strip()
                    if txt == label:
                        try:
                            val = el.locator('xpath=following-sibling::*[1]').inner_text(timeout=1000).strip()
                            if val and val != '—' and val != label:
                                return val
                        except Exception:
                            pass
                        try:
                            parent = el.locator('xpath=..').first
                            children = parent.locator('xpath=*').all()
                            if len(children) >= 2:
                                val = children[-1].inner_text(timeout=1000).strip()
                                if val and val != '—' and val != label:
                                    return val
                        except Exception:
                            pass
                except Exception:
                    continue
            return None
        except Exception:
            return None

    def get_any(*labels) -> str | None:
        for label in labels:
            v = get_labeled(label)
            if v:
                return v
        return None

    ter_raw = get_any('Wskaźnik kosztów całkowitych (TER)', 'TER')
    if ter_raw:
        try:
            out['ter'] = float(re.sub(r'[^\d,.]', '', ter_raw).replace(',', '.')) / 100
        except Exception:
            pass

    aum_raw = get_any('Wielkość (AuM)', 'Wielkość')
    if aum_raw:
        try:
            nums = re.findall(r'[\d]+[,.][\d]+|[\d]+', aum_raw.replace('\xa0', '').replace(' ', ''))
            val = float(nums[0].replace(',', '.')) if nums else None
            if val:
                if 'mld' in aum_raw.lower():
                    val *= 1000
                out['aum_pln'] = val
        except Exception:
            pass

    rep_raw = get_any('Replikacja')
    if rep_raw:
        out['replication'] = rep_raw

    div_raw = get_any('Polityka dywidendowa', 'Dywidendy')
    out['dividends'] = atlas_dividends(div_raw)

    domicile_raw = get_any('Siedziba funduszu')
    if domicile_raw:
        out['domicile_country'] = re.sub(r'[\U0001F1E0-\U0001F1FF\U0001F3F4\U0001F6A9]+', '', domicile_raw).strip()

    active_raw  = get_any('Aktywnie zarządzany')
    lever_raw   = get_any('Fundusz lewarowany')
    inverse_raw = get_any('Fundusz odwrócony')
    out['strategy'] = atlas_strategy(active_raw, lever_raw, inverse_raw)

    hedged_raw = get_any('Zabezpieczenie walutowe')
    out['hedged'] = 0 if (not hedged_raw or hedged_raw == '—') else 1

    out['asset_class'] = get_any('Klasa aktywów')
    out['region']      = get_any('Obszar inwestycji')
    out['category']    = get_any('Kategoria')

    return out

# ── Yahoo Finance ─────────────────────────────────────────────────────────────
try:
    import yfinance as yf
    YF_OK = True
except ImportError:
    YF_OK = False
    print("[WARN] yfinance nie zainstalowany — brak danych historycznych", file=sys.stderr)

def fetch_yf_prices(ticker_wa: str, days: int = 380) -> list[float]:
    """
    Pobiera dzienne ceny zamknięcia z Yahoo Finance.
    ticker_wa: np. 'ETFBM40TR.WA'
    Zwraca listę cen Close, posortowaną chronologicznie (od najstarszej).
    """
    if not YF_OK:
        return []
    try:
        t = yf.Ticker(ticker_wa)
        df = t.history(period='18mo', interval='1d', auto_adjust=True)
        if df.empty:
            return []
        # Filtruj do ostatnich `days` dni
        cutoff = datetime.today() - timedelta(days=days)
        df = df[df.index >= cutoff.strftime('%Y-%m-%d')]
        prices = df['Close'].dropna().tolist()
        return prices
    except Exception as e:
        print(f"[YF] Błąd {ticker_wa}: {e}", file=sys.stderr)
        return []

def enrich_from_yf(ticker: str) -> dict:
    ticker_wa = ticker.upper() + '.WA'
    prices = fetch_yf_prices(ticker_wa)
    if not prices:
        print(f"[YF] Brak danych dla {ticker_wa}", file=sys.stderr)
        return {}
    print(f"[YF] {ticker_wa}: {len(prices)} cen", file=sys.stderr)
    return {
        'perf_1m':    prices_to_perf(prices, 21),
        'perf_3m':    prices_to_perf(prices, 63),
        'perf_6m':    prices_to_perf(prices, 126),
        'perf_12m':   prices_to_perf(prices, 252),
        'mdd12m':     prices_to_mdd(prices, 252),
        'volatility': prices_to_vol(prices[-252:] if len(prices) >= 252 else prices),
    }

# ── Kalkulacje ────────────────────────────────────────────────────────────────
def prices_to_perf(prices: list[float], trading_days: int) -> float | None:
    if len(prices) <= trading_days:
        return None
    old = prices[-(trading_days + 1)]
    new = prices[-1]
    if old <= 0:
        return None
    return new / old - 1

def prices_to_mdd(prices: list[float], trading_days: int = 252) -> float | None:
    window = prices[-trading_days:] if len(prices) >= trading_days else prices
    if len(window) < 2:
        return None
    peak = window[0]
    max_dd = 0.0
    for p in window:
        if p > peak:
            peak = p
        dd = (p - peak) / peak
        if dd < max_dd:
            max_dd = dd
    return max_dd if max_dd < 0 else None

def prices_to_vol(prices: list[float]) -> float | None:
    if len(prices) < 20:
        return None
    log_r = [math.log(prices[i] / prices[i-1]) for i in range(1, len(prices))]
    n = len(log_r)
    mean = sum(log_r) / n
    var = sum((r - mean) ** 2 for r in log_r) / (n - 1)
    return math.sqrt(var) * math.sqrt(252)

def enrich_from_stooq(ticker: str, page=None) -> dict:
    """Alias dla kompatybilności — używa yfinance."""
    return enrich_from_yf(ticker)

# ── NBP EUR/PLN ───────────────────────────────────────────────────────────────
def fetch_eur_pln() -> float | None:
    try:
        url = 'https://api.nbp.pl/api/exchangerates/rates/a/EUR/last/1/?format=json'
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        return data['rates'][0]['mid']
    except Exception as e:
        print(f"[NBP] Błąd pobierania EUR/PLN: {e}", file=sys.stderr)
        return None

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    now = datetime.utcnow().isoformat()
    rules = load_group_rules()
    eur_pln = fetch_eur_pln()
    if eur_pln:
        print(f"[NBP] EUR/PLN = {eur_pln:.4f}", file=sys.stderr)

    # 1. GPW → lista instrumentów
    gpw_list = fetch_all_gpw()
    if not gpw_list:
        print("[WARN] Brak danych z GPW", file=sys.stderr)
        return

    by_isin: dict[str, dict] = {}
    for e in gpw_list:
        by_isin[e['isin']] = e

    isins = list(by_isin.keys())
    print(f"[GPW] Łącznie {len(isins)} unikalnych instrumentów", file=sys.stderr)

    # Pomiń ISINy które już są w bazie z JustETF
    try:
        import sqlite3
        db_path = os.environ.get('DATA_DIR', '/app/data') + '/momentum.db'
        con = sqlite3.connect(db_path)
        existing = {r[0] for r in con.execute(
            "SELECT isin FROM etfs WHERE source='justetf' AND isin IN (%s)"
            % ','.join('?' * len(isins)), isins
        ).fetchall()}
        con.close()
        if existing:
            print(f"[GPW] Pomijam {len(existing)} ISINów już w JustETF", file=sys.stderr)
            isins = [i for i in isins if i not in existing]
            by_isin = {i: by_isin[i] for i in isins}
    except Exception as e:
        print(f"[GPW] Nie można sprawdzić bazy: {e}", file=sys.stderr)

    if not isins:
        print("[GPW] Brak nowych instrumentów do pobrania", file=sys.stderr)
        return

    if not PW_OK:
        print("[WARN] Playwright niedostępny — brak danych AtlasETF", file=sys.stderr)
        return

    # 2. Jeden browser dla AtlasETF
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
        ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
        atlas_ctx = browser.new_context(user_agent=ua)
        atlas_page = atlas_ctx.new_page()
        atlas_page.set_default_timeout(30_000)

        # 3. AtlasETF batch
        atlas_data = scrape_atlas_batch(isins, atlas_page)
        browser.close()

    # 4. Składamy wyniki (yfinance nie potrzebuje Playwright)
    for isin, base in by_isin.items():
        atlas = atlas_data.get(isin, {})
        ticker = base.get('ticker', '')

        yf_data = enrich_from_yf(ticker) if ticker else {}

        aum_mln = None
        if atlas.get('aum_pln') and eur_pln:
            aum_mln = atlas['aum_pln'] / eur_pln

        name = atlas.get('name') or ticker or isin
        asset_class = atlas.get('asset_class')
        group_key = make_group_key(name, asset_class, rules, source=SOURCE)

        record = {
            'isin':             isin,
            'name':             name,
            'ticker':           ticker,
            'currency':         base.get('currency', 'PLN'),
            'instrument':       base.get('instrument', 'ETF'),
            'ter':              atlas.get('ter'),
            'aum_mln':          aum_mln,
            'dividends':        atlas.get('dividends'),
            'replication':      atlas.get('replication'),
            'strategy':         atlas.get('strategy', 'long-only'),
            'hedged':           atlas.get('hedged', 0),
            'domicile_country': atlas.get('domicile_country'),
            'asset_class':      asset_class,
            'region':           atlas.get('region'),
            'perf_1m':          yf_data.get('perf_1m'),
            'perf_3m':          yf_data.get('perf_3m'),
            'perf_6m':          yf_data.get('perf_6m'),
            'perf_12m':         yf_data.get('perf_12m'),
            'mdd12m':           yf_data.get('mdd12m'),
            'volatility':       yf_data.get('volatility'),
            'group_key':        group_key,
            'source':           SOURCE,
            'fetched_at':       now,
        }
        print(json.dumps(record, ensure_ascii=False))

if __name__ == '__main__':
    main()
