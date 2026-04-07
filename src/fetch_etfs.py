#!/usr/bin/env python3
"""fetch_etfs.py MAX_ETFS"""
import sys, json, math, re, os
import pandas as pd

try:
    import justetf_scraping
except ImportError as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr); sys.exit(1)

try:
    import yaml
    YAML_OK = True
except ImportError:
    YAML_OK = False

# ── Provider list (longest first) ────────────────────────────────────────────
PROVIDERS = sorted([
    'ishares core','ishares','amundi is','amundi','xtrackers','vanguard',
    'spdr','invesco','hsbc','ubs etf','ubs','lyxor','bnp paribas easy','bnp paribas',
    'franklin','wisdomtree','vaneck','fidelity','ossiam','dws','state street',
    'pimco','blackrock','jp morgan','jpmorgan','legal & general','lgim',
    'nomura','samsung','mirae asset','global x','first trust','hanetf',
    'l&g','tabula','rize','sprott','comstage','db x-trackers','db xtrackers',
    'etf securities','axa im','axa',
    'goldman sachs','gs ',
    'man','europa','ossiam','wellington','robeco','neuberger berman',
    'ubs (irl)','ubs (lux)',
    'jp morgan','jpm','morgan stanley',
    'horizon kinetics','guinness','flossbach',
    'deka','dekabank',
    'bnp easy','bnp',
    'societe generale','sg ',
    'natixis','candriam','oddo bhf',
    'swisscanto','raiffeisen',
    'arctic','storebrand','nordea',
    'fidelity institutional',
    'aberdeen','abrdn',
    'ubs fund services',
    'columbia threadneedle','threadneedle',
    'credit suisse','ubs key',
    'wisdomtree issuer',
], key=len, reverse=True)

STRATEGY_MAP = {
    'Long-only':          'long-only',
    'Long-only, Active':  'active',
    'Short & Leveraged':  'short-leveraged',
}

def load_group_rules():
    """Load compiled regex rules from groups.yaml."""
    groups_path = os.path.join(os.path.dirname(__file__), '..', 'groups.yaml')
    if not YAML_OK:
        print("PyYAML nie zainstalowany — grupowanie z groups.yaml wyłączone", file=sys.stderr)
        return []
    if not os.path.exists(groups_path):
        print(f"groups.yaml nie znaleziony: {groups_path}", file=sys.stderr)
        return []
    try:
        with open(groups_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        rules = []
        for r in (data.get('rules') or []):
            pattern = r.get('pattern','')
            group   = r.get('group','')
            if not pattern or not group:
                continue
            types_raw = r.get('types')
            if types_raw is None:
                types = None
            elif isinstance(types_raw, list):
                types = set(types_raw)
            else:
                types = {types_raw}
            sources_raw = r.get('sources')
            if sources_raw is None:
                sources = None
            elif isinstance(sources_raw, list):
                sources = set(sources_raw)
            else:
                sources = {sources_raw}
            try:
                rules.append((re.compile(pattern, re.IGNORECASE), group, types, sources))
            except re.error as e:
                print(f"[WARN] Zły regex '{pattern}': {e}", file=sys.stderr)
        print(f"Załadowano {len(rules)} reguł grupowania", file=sys.stderr)
        return rules
    except Exception as e:
        print(f"Błąd ładowania groups.yaml: {e}", file=sys.stderr)
        return []

def clean_name(name):
    """Strip provider prefix and UCITS ETF/ETC/ETN suffix — returns cleaned lowercase."""
    key = (name or '').strip().lower()
    for p in PROVIDERS:
        if key.startswith(p + ' '):
            key = key[len(p):].strip(); break
    key = re.sub(r'\s+ucits\s+etf\b\s*[-–]?\s*', ' ', key).strip()
    # Strip ETC/ETF/ETN only at end — not mid-name (e.g. "SG ETC Gold Futures")
    key = re.sub(r'\s+(?:etc|etn|etf)\s*$', '', key)
    return re.sub(r'\s+', ' ', key).strip()

def make_group_key(name, asset_class, rules, source='justetf'):
    """
    1. Try groups.yaml rules (in order) on cleaned name.
       If rule has types, skip unless asset_class matches.
       If rule has sources, skip unless source matches.
    2. Fallback: asset_class:cleaned_name
    """
    cleaned = clean_name(name)
    ac = (asset_class or '').strip()
    for pattern, group, types, sources in rules:
        if types is not None and ac not in types:
            continue
        if sources is not None and source not in sources:
            continue
        if pattern.search(cleaned):
            return group
    # Fallback
    ac_key = ac.lower().replace(' ', '-')
    return f"{ac_key}:{cleaned}" if ac_key and cleaned else cleaned or name.lower()

def safe(val):
    if val is None: return None
    try:
        f = float(val)
        return None if math.isnan(f) else f
    except: return None

def pct(val):
    v = safe(val)
    return v / 100.0 if v is not None else None

def norm_div(raw):
    if not raw: return None
    dl = str(raw).lower()
    if 'accum' in dl or 'capitaliz' in dl or 'thesaur' in dl: return 'Acc'
    if 'distrib' in dl or 'ausschütt' in dl or 'income' in dl: return 'Dist'
    return str(raw)[:10]

def main():
    max_etfs = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    rules = load_group_rules()

    print(f"Pobieranie (enrich=True, max {max_etfs})...", file=sys.stderr)
    try:
        df = justetf_scraping.load_overview(enrich=True)
    except Exception as e:
        print(f"enrich=True nie działa ({e}), próbuję bez...", file=sys.stderr)
        df = justetf_scraping.load_overview()

    df = df.reset_index()
    print(f"Wczytano {len(df)} ETFów, kolumny: {df.columns.tolist()}", file=sys.stderr)
    df = df.head(max_etfs)
    cols = set(df.columns)

    def col(*names):
        for n in names:
            if n in cols: return n
        return None

    isin_c = col('isin','ISIN');      name_c = col('name','fund_name')
    tick_c = col('ticker','wkn');     cur_c  = col('currency')
    ter_c  = col('ter');              aum_c  = col('size','fund_size','aum')
    div_c  = col('dividends','income_treatment')
    strat_c= col('strategy');         p1m_c  = col('last_month')
    p3m_c  = col('last_three_months');p6m_c  = col('last_six_months')
    p1y_c  = col('last_year');        vol_c  = col('last_year_volatility','volatility')
    mdd_c  = col('last_year_max_drawdown','max_drawdown','mdd','drawdown')
    rep_c  = col('replication');      dom_c  = col('domicile_country')
    ac_c   = col('asset_class');      reg_c  = col('region')
    inst_c = col('instrument');       hedg_c = col('hedged')
    nhld_c = col('number_of_holdings')

    count = 0
    for _, row in df.iterrows():
        isin = str(row[isin_c]).strip() if isin_c else None
        if not isin or len(isin) != 12: continue

        name     = str(row[name_c]).strip() if name_c and pd.notna(row.get(name_c)) else 'Unknown'
        ac       = str(row[ac_c]).strip()   if ac_c   and pd.notna(row.get(ac_c))   else ''
        region   = str(row[reg_c]).strip()  if reg_c  and pd.notna(row.get(reg_c))  else None
        domicile = str(row[dom_c]).strip()  if dom_c  and pd.notna(row.get(dom_c))  else None
        instr    = str(row[inst_c]).strip() if inst_c and pd.notna(row.get(inst_c)) else None

        strat_raw = str(row[strat_c]).strip() if strat_c and pd.notna(row.get(strat_c)) else ''
        strategy  = STRATEGY_MAP.get(strat_raw, strat_raw.lower() or 'long-only')

        hedged = False
        if hedg_c:
            hv = row.get(hedg_c)
            try:    hedged = bool(hv) if pd.notna(hv) else False
            except: pass

        ter_raw    = safe(row[ter_c]) if ter_c else None
        ter_stored = ter_raw / 100.0  if ter_raw is not None else None  # 0.07 → 0.0007

        etf = {
            "isin":             isin,
            "name":             name,
            "ticker":           str(row[tick_c]).strip() if tick_c and pd.notna(row.get(tick_c)) else None,
            "currency":         str(row[cur_c]).strip()  if cur_c  and pd.notna(row.get(cur_c))  else 'EUR',
            "ter":              ter_stored,
            "aum_mln":          safe(row[aum_c])     if aum_c   else None,
            "dividends":        norm_div(row[div_c]) if div_c and pd.notna(row.get(div_c)) else None,
            "perf_1m":          pct(row[p1m_c])      if p1m_c   else None,
            "perf_3m":          pct(row[p3m_c])      if p3m_c   else None,
            "perf_6m":          pct(row[p6m_c])      if p6m_c   else None,
            "perf_12m":         pct(row[p1y_c])      if p1y_c   else None,
            "volatility":       pct(row[vol_c])      if vol_c   else None,
            "mdd12m":           pct(row[mdd_c])      if mdd_c   else None,
            "replication":      str(row[rep_c]).strip() if rep_c and pd.notna(row.get(rep_c)) else None,
            "strategy":         strategy,
            "asset_class":      ac      or None,
            "region":           region  or None,
            "domicile_country": domicile or None,
            "instrument":       instr   or None,
            "hedged":           1 if hedged else 0,
            "n_holdings":       int(row[nhld_c]) if nhld_c and pd.notna(row.get(nhld_c)) else None,
            "group_key":        make_group_key(name, ac, rules),
        }
        print(json.dumps(etf, ensure_ascii=False))
        count += 1

    print(f"Wyeksportowano {count} ETFów", file=sys.stderr)

if __name__ == "__main__":
    main()
