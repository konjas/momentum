const { getAllEtfs, saveRanking, getIgnoredIsins, getOwnedIsins, getGroupOverrides } = require('./database');
const { convertReturnToPLN } = require('./nbp');
const log = (...a) => console.log('[RANKING]', ...a);

function computeScores(etf, weights) {
  // Biblioteka justetf_scraping zwraca performance w EUR —
  // niezależnie od etf.currency (waluta indeksu bazowego).
  // Potwierdzone empirycznie dla USD, CHF, GBP.
  const fx   = 'EUR';
  const r1m  = convertReturnToPLN(etf.perf_1m,  fx, '1m');
  const r3m  = convertReturnToPLN(etf.perf_3m,  fx, '3m');
  const r6m  = convertReturnToPLN(etf.perf_6m,  fx, '6m');
  const r12m = convertReturnToPLN(etf.perf_12m, fx, '12m');
  const vol  = etf.volatility;
  const mdd  = etf.mdd12m; // już w formie dziesiętnej (np. -0.23), lub null

  // R(t-12, t-1) = R12M bez ostatniego miesiąca
  // Wzór: (1 + R12M) / (1 + R1M) - 1  — obliczamy w PLN
  let r12m_skip1m = null;
  if (r12m != null && r1m != null && r1m !== -1) {
    r12m_skip1m = (1 + r12m) / (1 + r1m) - 1;
  }

  const candidates = [
    { key: 'r1m',         r: r1m,         w: weights.r1m         ?? 0 },
    { key: 'r3m',         r: r3m,         w: weights.r3m         ?? 0 },
    { key: 'r6m',         r: r6m,         w: weights.r6m         ?? 0 },
    { key: 'r12m',        r: r12m,        w: weights.r12m        ?? 0 },
    { key: 'r12m_skip1m', r: r12m_skip1m, w: weights.r12m_skip1m ?? 0 },
    { key: 'mdd12m',      r: mdd,         w: weights.mdd12m      ?? 0 },
  ].filter(p => p.r != null && p.w !== 0);

  if (candidates.length < 2) return {
    r1m_pln:r1m, r3m_pln:r3m, r6m_pln:r6m, r12m_pln:r12m,
    r12m_skip1m_pln:r12m_skip1m, mdd12m:mdd,
    vol_pln:vol, ms_raw:null, ms_adj:null,
  };

  const tw     = candidates.reduce((s,p) => s + p.w, 0);
  const ms_raw = candidates.reduce((s,p) => s + p.r * (p.w / tw), 0) * (1 - );
  const ms_adj = (vol && vol > 0) ? ms_raw / vol : ms_raw;
  return {
    r1m_pln:r1m, r3m_pln:r3m, r6m_pln:r6m, r12m_pln:r12m,
    r12m_skip1m_pln:r12m_skip1m, mdd12m:mdd,
    vol_pln:vol, ms_raw, ms_adj,
  };
}

function num(v) { return (v === '' || v == null) ? null : +v; }

function passesFilters(etf, scores, f) {
  const minAum  = num(f.defaultMinAumMillions);
  const maxAum  = num(f.defaultMaxAumMillions);
  const minTer  = num(f.defaultMinTer);
  const maxTer  = num(f.defaultMaxTer);
  const minVol  = num(f.defaultMinVolatility);
  const maxVol  = num(f.defaultMaxVolatility);
  const minMS   = num(f.defaultMinMS);
  const maxMS   = num(f.defaultMaxMS);
  const minAdj  = num(f.defaultMinAdjMS);
  const maxAdj  = num(f.defaultMaxAdjMS);
  const minR12  = num(f.defaultMinR12M);
  const maxR12  = num(f.defaultMaxR12M);
  const minMDD  = num(f.defaultMinMDD12M);
  const maxMDD  = num(f.defaultMaxMDD12M);

  if (minAum  != null && (etf.aum_mln    == null || etf.aum_mln         < minAum))  return false;
  if (maxAum  != null &&  etf.aum_mln    != null && etf.aum_mln         > maxAum)   return false;
  if (minTer  != null && (etf.ter        == null || etf.ter * 100        < minTer))  return false;
  if (maxTer  != null && (etf.ter        == null || etf.ter * 100        > maxTer))  return false;
  if (minVol  != null && (scores.vol_pln  == null || scores.vol_pln*100  < minVol))  return false;
  if (maxVol  != null &&  scores.vol_pln  != null && scores.vol_pln*100  > maxVol)   return false;
  if (minMS   != null && (scores.ms_raw   == null || scores.ms_raw*100   < minMS))   return false;
  if (maxMS   != null &&  scores.ms_raw   != null && scores.ms_raw*100   > maxMS)    return false;
  if (minAdj  != null && (scores.ms_adj   == null || scores.ms_adj       < minAdj))  return false;
  if (maxAdj  != null &&  scores.ms_adj   != null && scores.ms_adj       > maxAdj)   return false;
  if (minR12  != null && (scores.r12m_pln  == null || scores.r12m_pln*100 < minR12)) return false;
  if (maxR12  != null &&  scores.r12m_pln  != null && scores.r12m_pln*100 > maxR12)  return false;
  // MDD jest ujemne (np. -0.23 = -23%), więc min=-25 odcina MDD < -25%
  if (minMDD  != null && (scores.mdd12m   == null || scores.mdd12m*100   < minMDD))  return false;
  if (maxMDD  != null &&  scores.mdd12m   != null && scores.mdd12m*100   > maxMDD)   return false;

  for (const [field, excluded] of [
    ['strategy',         f.defaultStrategies ?? []],
    ['dividends',        f.defaultDividends  ?? []],
    ['domicile_country', f.defaultCountries  ?? []],
  ]) {
    if (excluded.length && etf[field] && excluded.includes(etf[field])) return false;
  }
  return true;
}

function computeRanking(config) {
  log('Obliczam ranking...');
  const etfs       = getAllEtfs();
  const weights    = config.ranking.weights;
  const filters    = config.filters || {};
  const ignoredSet = new Set(getIgnoredIsins());
  const ownedSet   = new Set(getOwnedIsins());
  const overrides  = getGroupOverrides();
  const now        = new Date().toISOString();

  // 1. Score + filtruj (ignorowane pomijamy — nie wchodzą do rankingu)
  const allScored = [];
  for (const etf of etfs) {
    if (ignoredSet.has(etf.isin)) continue;
    const scores = computeScores(etf, weights);
    if (scores.ms_adj == null && scores.ms_raw == null) continue;
    if (!passesFilters(etf, scores, filters)) continue;
    allScored.push({
      isin:             etf.isin,
      name:             etf.name,
      ticker:           etf.ticker,
      currency:         etf.currency,
      ter:              etf.ter,
      aum_mln:          etf.aum_mln,
      dividends:        etf.dividends,
      strategy:         etf.strategy,
      asset_class:      etf.asset_class      ?? null,
      region:           etf.region           ?? null,
      domicile_country: etf.domicile_country ?? null,
      instrument:       etf.instrument       ?? null,
      hedged:           etf.hedged           ?? 0,
      group_key:        etf.group_key || etf.isin,
      ...scores,
      ignored: 0,
      owned:   ownedSet.has(etf.isin) ? 1 : 0,
    });
  }
  allScored.sort((a,b) => (b.ms_adj??b.ms_raw??-Infinity) - (a.ms_adj??a.ms_raw??-Infinity));

  // 2. Rozmiary grup (po filtrach)
  const groupSizes = new Map();
  for (const e of allScored) groupSizes.set(e.group_key, (groupSizes.get(e.group_key)||0)+1);

  // 3. Dedup — jeden rep per grupa
  //    Override (user wybiera repa ręcznie) > najwyższy MS_adj
  const overrideGroups = new Set(Object.keys(overrides));
  const groups = new Map();
  for (const e of allScored) {
    const prefIsin = overrides[e.group_key];
    const cur = groups.get(e.group_key);
    if (prefIsin && e.isin === prefIsin) {
      groups.set(e.group_key, { ...e, _override: true });
    } else if (!cur?._override && !cur) {
      groups.set(e.group_key, e);
    }
  }

  // 4. Sortuj, przypisz rank_pos
  const active = [...groups.values()];
  active.sort((a,b) => (b.ms_adj??-Infinity) - (a.ms_adj??-Infinity));

  active.forEach((e, i) => {
    e.group_size  = groupSizes.get(e.group_key) || 1;
    e.rank_pos    = i + 1;
    e.is_override = e._override ? 1 : 0;
    e.computed_at = now;
  });

  saveRanking(active);
  log(`Wynik: ${active.length} grup z ${allScored.length} ETFów (po filtrach)`);
  return active.length;
}

module.exports = { computeRanking, computeScores, passesFilters };
