const express = require('express');
const path    = require('path');
const fs      = require('fs');
const yaml    = require('js-yaml');
const log     = (...a) => console.log('[SERVER]', ...a);
const {
  getRanking, getRankingMeta, getLastJob, getJobHistory,
  addIgnored, removeIgnored, getIgnoredList, getIgnoredIsins,
  addOwned, removeOwned, getOwnedIsins, getOwnedList,
  setGroupOverride, clearGroupOverride,
  getEtfsByGroupKey, getEtfByIsin,
  getAllBrokerIsins, getBrokerUpdates,
} = require('./database');
const { computeScores, passesFilters } = require('./ranking');
const { runFullUpdate, runBrokerUpdate, recomputeRankingOnly, startCron, getStatus } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

const CONFIG_PATH = path.join('/app', 'config.yaml');
const CONFIG_DEFAULT = {
  ranking: { weights:{r1m:.10,r3m:.20,r6m:.45,r12m:.00,r12m_skip1m:.25,mdd12m:.00} },
  filters: { excludeIsins:[], defaultBrokers:[] },
  scraper: { maxEtfs:10000 },
};

function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || CONFIG_DEFAULT;
  } catch(e) {
    log(`Błąd config.yaml: ${e.message} — używam domyślnych`);
    return CONFIG_DEFAULT;
  }
}

function enrich(r, cfg) {
  return {
    ...r,
    r1m_pln_pct:         r.r1m_pln         != null ? +(r.r1m_pln         *100).toFixed(2) : null,
    r3m_pln_pct:         r.r3m_pln         != null ? +(r.r3m_pln         *100).toFixed(2) : null,
    r6m_pln_pct:         r.r6m_pln         != null ? +(r.r6m_pln         *100).toFixed(2) : null,
    r12m_pln_pct:        r.r12m_pln        != null ? +(r.r12m_pln        *100).toFixed(2) : null,
    r12m_skip1m_pln_pct: r.r12m_skip1m_pln != null ? +(r.r12m_skip1m_pln*100).toFixed(2) : null,
    mdd12m_pct:          r.mdd12m          != null ? +(r.mdd12m          *100).toFixed(2) : null,
    vol_pct:             r.vol_pln         != null ? +(r.vol_pln         *100).toFixed(2) : null,
    ms_raw_pct:          r.ms_raw          != null ? +(r.ms_raw          *100).toFixed(2) : null,
    ms_adj_val:          r.ms_adj          != null ? +r.ms_adj.toFixed(4)                 : null,
  };
}

/** Dodaje listę brokerów do każdego wiersza na podstawie broker_isins. */
function addBrokers(rows, brokerIsins) {
  const brokers = Object.keys(brokerIsins);
  return rows.map(r => ({
    ...r,
    brokers: brokers.filter(b => brokerIsins[b]?.has(r.isin)),
  }));
}

app.use(express.json());
app.use(express.static(path.join(__dirname,'../public')));
app.use('/api',(q,s,n)=>{ console.log(`[API] ${q.method} ${q.path}`); n(); });

// ── GET /api/ranking ──────────────────────────────────────────────────────────
app.get('/api/ranking', (req,res) => {
  try {
    const config      = loadConfig();
    const rows        = getRanking();
    const meta        = getRankingMeta();
    const brokerIsins = getAllBrokerIsins();
    res.json({ ok:true,
      data: addBrokers(rows.map(r => enrich(r, config.ranking)), brokerIsins),
      meta: { total: meta?.total ?? 0, computedAt: meta?.computed_at ?? null,
              weights: config.ranking.weights } });
  } catch(err) { console.error('[API] ranking:', err); res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', (req,res) => {
  try {
    const { isRunning, lastRunResult, isBrokerRunning, lastBrokerResult } = getStatus();
    const meta = getRankingMeta();
    res.json({ ok:true, isRunning, lastRunResult, isBrokerRunning, lastBrokerResult,
      lastJob: getLastJob(),
      rankingComputedAt: meta?.computed_at ?? null,
      rankingTotal: meta?.total ?? 0,
    });
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req,res) => {
  try { res.json({ok:true, data:getJobHistory()}); }
  catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── POST /api/refresh ─────────────────────────────────────────────────────────
app.post('/api/refresh', (req,res) => {
  const { isRunning } = getStatus();
  if (isRunning) return res.status(409).json({ok:false,error:'Już trwa'});
  runFullUpdate(loadConfig()).catch(e => console.error('[API] refresh:', e));
  res.status(202).json({ok:true});
});

// ── POST /api/refresh-brokers ─────────────────────────────────────────────────
app.post('/api/refresh-brokers', (req,res) => {
  const { isBrokerRunning } = getStatus();
  if (isBrokerRunning) return res.status(409).json({ok:false,error:'Aktualizacja brokerów już trwa'});
  runBrokerUpdate(loadConfig()).catch(e => console.error('[API] refresh-brokers:', e));
  res.status(202).json({ok:true});
});

// ── GET /api/brokers ──────────────────────────────────────────────────────────
app.get('/api/brokers', (req,res) => {
  try {
    const updates     = getBrokerUpdates();
    const brokerIsins = getAllBrokerIsins();
    const { isBrokerRunning, lastBrokerResult } = getStatus();
    res.json({ ok:true,
      isRunning: isBrokerRunning,
      lastResult: lastBrokerResult,
      brokers: updates,
      counts: Object.fromEntries(
        Object.entries(brokerIsins).map(([b, s]) => [b, s.size])
      ),
    });
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/config ───────────────────────────────────────────────────────────
app.get('/api/config', (req,res) => {
  try { res.json({ ok:true, data:loadConfig() }); }
  catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── Ignored ───────────────────────────────────────────────────────────────────
app.post('/api/ignore/:isin', (req,res) => {
  try {
    addIgnored(req.params.isin);
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.delete('/api/ignore/:isin', (req,res) => {
  try {
    removeIgnored(req.params.isin);
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.get('/api/ignored', (req,res) => {
  try {
    const config      = loadConfig();
    const brokerIsins = getAllBrokerIsins();
    res.json({ok:true,
      data: addBrokers(getIgnoredList().map(r => enrich(r, config.ranking)), brokerIsins)
    });
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── Owned ─────────────────────────────────────────────────────────────────────
app.get('/api/owned', (req,res) => {
  try {
    const config      = loadConfig();
    const brokerIsins = getAllBrokerIsins();
    const list = getOwnedList().map(r => {
      if (r.r1m_pln == null && r.r3m_pln == null) {
        const etf = getEtfByIsin(r.isin);
        if (etf) {
          const s = computeScores(etf, config.ranking.weights);
          r.r1m_pln         = s.r1m_pln;
          r.r3m_pln         = s.r3m_pln;
          r.r6m_pln         = s.r6m_pln;
          r.r12m_pln        = s.r12m_pln;
          r.r12m_skip1m_pln = s.r12m_skip1m_pln;
          r.mdd12m          = s.mdd12m;
          r.vol_pln         = s.vol_pln;
          r.ms_adj          = s.ms_adj;
          r.ms_raw          = s.ms_raw;
        }
      }
      return enrich(r, config.ranking);
    });
    res.json({ok:true, data: addBrokers(list, brokerIsins)});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.post('/api/owned/:isin', (req,res) => {
  try {
    addOwned(req.params.isin);
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.delete('/api/owned/:isin', (req,res) => {
  try {
    removeOwned(req.params.isin);
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── Group rep override ────────────────────────────────────────────────────────
app.post('/api/group/:key/rep', (req,res) => {
  try {
    const key  = decodeURIComponent(req.params.key);
    const isin = req.body?.isin;
    if (!isin) return res.status(400).json({ok:false,error:'Brak ISIN'});
    setGroupOverride(key, isin);
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,group_key:key,rep_isin:isin,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.delete('/api/group/:key/rep', (req,res) => {
  try {
    clearGroupOverride(decodeURIComponent(req.params.key));
    const count = recomputeRankingOnly(loadConfig());
    res.json({ok:true,rankingCount:count});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/group/:key ───────────────────────────────────────────────────────
app.get('/api/group/:key', (req,res) => {
  try {
    const key         = decodeURIComponent(req.params.key);
    const config      = loadConfig();
    const filters     = config.filters || {};
    const igSet       = new Set(getIgnoredIsins());
    const owSet       = new Set(getOwnedIsins());
    const brokerIsins = getAllBrokerIsins();

    const scored = getEtfsByGroupKey(key)
      .map(etf => {
        const s = computeScores(etf, config.ranking.weights);
        return {
          isin: etf.isin, name: etf.name, ticker: etf.ticker,
          currency: etf.currency, ter: etf.ter, aum_mln: etf.aum_mln,
          dividends: etf.dividends, strategy: etf.strategy,
          domicile_country: etf.domicile_country,
          ignored: igSet.has(etf.isin) ? 1 : 0,
          owned:   owSet.has(etf.isin) ? 1 : 0,
          brokers: Object.keys(brokerIsins).filter(b => brokerIsins[b]?.has(etf.isin)),
          _s: s,
          ms_adj_val:          s.ms_adj          != null ? +s.ms_adj.toFixed(4)                  : null,
          ms_raw_pct:          s.ms_raw          != null ? +(s.ms_raw          *100).toFixed(2)  : null,
          r1m_pln_pct:         s.r1m_pln         != null ? +(s.r1m_pln         *100).toFixed(2)  : null,
          r3m_pln_pct:         s.r3m_pln         != null ? +(s.r3m_pln         *100).toFixed(2)  : null,
          r6m_pln_pct:         s.r6m_pln         != null ? +(s.r6m_pln         *100).toFixed(2)  : null,
          r12m_pln_pct:        s.r12m_pln        != null ? +(s.r12m_pln        *100).toFixed(2)  : null,
          r12m_skip1m_pln_pct: s.r12m_skip1m_pln != null ? +(s.r12m_skip1m_pln*100).toFixed(2)  : null,
          mdd12m_pct:          s.mdd12m          != null ? +(s.mdd12m          *100).toFixed(2)  : null,
          vol_pct:             s.vol_pln         != null ? +(s.vol_pln         *100).toFixed(2)  : null,
        };
      })
      .filter(e => {
        if (e.ms_adj_val == null) return false;
        if (e.ignored) return true;
        const etfFields = {
          isin: e.isin, aum_mln: e.aum_mln, ter: e.ter,
          strategy: e.strategy, dividends: e.dividends,
          domicile_country: e.domicile_country,
        };
        return passesFilters(etfFields, e._s, filters, brokerIsins);
      })
      .map(e => { delete e._s; return e; })
      .sort((a,b) => (b.ms_adj_val??-Infinity) - (a.ms_adj_val??-Infinity));

    res.json({ok:true, group_key:key, data:scored});
  } catch(err) { console.error('[API] group:', err); res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/ignored/count ────────────────────────────────────────────────────
app.get('/api/ignored/count', (req,res) => {
  try { res.json({ok:true, count:getIgnoredIsins().length}); }
  catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

async function main() {
  log('=== JustETF Momentum Ranking ===');
  const config = loadConfig();
  startCron(config);
  app.listen(PORT, '0.0.0.0', () => log(`http://0.0.0.0:${PORT}`));
  const meta = getRankingMeta();
  if (!meta?.total || meta.total === 0) {
    log('Baza pusta — uruchamiam aktualizację...');
    setTimeout(() => runFullUpdate(config), 2000);
  } else {
    log(`Baza: ${meta.total} ETFów (${meta.computed_at})`);
  }
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
