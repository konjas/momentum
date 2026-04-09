const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(process.env.DATA_DIR || '/app/data', 'momentum.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    runMigrations();
  }
  return db;
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS etfs (
      isin TEXT PRIMARY KEY, name TEXT NOT NULL, ticker TEXT,
      currency TEXT, ter REAL, aum_mln REAL, dividends TEXT, n_holdings INTEGER,
      perf_1m REAL, perf_3m REAL, perf_6m REAL, perf_12m REAL,
      volatility REAL, mdd12m REAL, replication TEXT, group_key TEXT, strategy TEXT,
      asset_class TEXT, region TEXT, domicile_country TEXT,
      instrument TEXT, hedged INTEGER DEFAULT 0,
      source TEXT DEFAULT 'justetf',
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranking (
      isin TEXT PRIMARY KEY, name TEXT, ticker TEXT, currency TEXT,
      ter REAL, aum_mln REAL, dividends TEXT, strategy TEXT,
      asset_class TEXT, region TEXT, domicile_country TEXT,
      instrument TEXT, hedged INTEGER DEFAULT 0,
      r1m_pln REAL, r3m_pln REAL, r6m_pln REAL, r12m_pln REAL,
      r12m_skip1m_pln REAL, mdd12m REAL,
      vol_pln REAL, ms_raw REAL, ms_adj REAL, rank_pos INTEGER,
      abs_ok INTEGER DEFAULT 0, buy_signal INTEGER DEFAULT 0, watch_zone INTEGER DEFAULT 0,
      ignored INTEGER DEFAULT 0, owned INTEGER DEFAULT 0,
      group_key TEXT, group_size INTEGER DEFAULT 1, is_override INTEGER DEFAULT 0,
      computed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fx_rates (
      currency TEXT NOT NULL, period TEXT NOT NULL,
      rate REAL NOT NULL, date TEXT NOT NULL,
      PRIMARY KEY (currency, period)
    );
    CREATE TABLE IF NOT EXISTS job_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT, etfs_fetched INTEGER, error_msg TEXT
    );
    CREATE TABLE IF NOT EXISTS ignored_etfs (isin TEXT PRIMARY KEY, ignored_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owned_etfs (isin TEXT PRIMARY KEY, bought_at TEXT NOT NULL, notes TEXT);
    CREATE TABLE IF NOT EXISTS group_overrides (
      group_key TEXT PRIMARY KEY, rep_isin TEXT NOT NULL, set_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS broker_isins (
      broker     TEXT NOT NULL,
      isin       TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (broker, isin)
    );
    CREATE TABLE IF NOT EXISTS broker_updates (
      broker      TEXT PRIMARY KEY,
      last_run_at TEXT,
      status      TEXT,
      isin_count  INTEGER,
      error_msg   TEXT
    );
  `);
}

function runMigrations() {
  const alters = [
    'ALTER TABLE etfs    ADD COLUMN group_key        TEXT',
    'ALTER TABLE etfs    ADD COLUMN dividends        TEXT',
    'ALTER TABLE etfs    ADD COLUMN n_holdings       INTEGER',
    'ALTER TABLE etfs    ADD COLUMN strategy         TEXT',
    'ALTER TABLE etfs    ADD COLUMN asset_class      TEXT',
    'ALTER TABLE etfs    ADD COLUMN region           TEXT',
    'ALTER TABLE etfs    ADD COLUMN domicile_country TEXT',
    'ALTER TABLE etfs    ADD COLUMN instrument       TEXT',
    'ALTER TABLE etfs    ADD COLUMN hedged           INTEGER DEFAULT 0',
    'ALTER TABLE ranking ADD COLUMN ignored          INTEGER DEFAULT 0',
    'ALTER TABLE ranking ADD COLUMN owned            INTEGER DEFAULT 0',
    'ALTER TABLE ranking ADD COLUMN group_key        TEXT',
    'ALTER TABLE ranking ADD COLUMN group_size       INTEGER DEFAULT 1',
    'ALTER TABLE ranking ADD COLUMN dividends        TEXT',
    'ALTER TABLE ranking ADD COLUMN strategy         TEXT',
    'ALTER TABLE ranking ADD COLUMN asset_class      TEXT',
    'ALTER TABLE ranking ADD COLUMN region           TEXT',
    'ALTER TABLE ranking ADD COLUMN domicile_country TEXT',
    'ALTER TABLE ranking ADD COLUMN instrument       TEXT',
    'ALTER TABLE ranking ADD COLUMN is_override INTEGER DEFAULT 0',
    'ALTER TABLE ranking ADD COLUMN buy_signal  INTEGER DEFAULT 0',
    'ALTER TABLE ranking ADD COLUMN watch_zone  INTEGER DEFAULT 0',
    'ALTER TABLE etfs    ADD COLUMN mdd12m           REAL',
    'ALTER TABLE ranking ADD COLUMN r12m_skip1m_pln  REAL',
    'ALTER TABLE ranking ADD COLUMN mdd12m           REAL',
    'ALTER TABLE etfs    ADD COLUMN source           TEXT DEFAULT \'justetf\'',
    // broker tables (CREATE IF NOT EXISTS handles new installs; alters for upgrades)
    `CREATE TABLE IF NOT EXISTS broker_isins (
      broker TEXT NOT NULL, isin TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (broker, isin))`,
    `CREATE TABLE IF NOT EXISTS broker_updates (
      broker TEXT PRIMARY KEY, last_run_at TEXT, status TEXT,
      isin_count INTEGER, error_msg TEXT)`,
  ];
  for (const sql of alters) { try { getDb().prepare(sql).run(); } catch (_) {} }
}

// ── ETFs ─────────────────────────────────────────────────────────────────────

const ETFS_DEFAULTS = {
  isin:null, name:'Unknown', ticker:null, currency:'EUR', ter:null, aum_mln:null,
  dividends:null, n_holdings:null, perf_1m:null, perf_3m:null, perf_6m:null,
  perf_12m:null, volatility:null, mdd12m:null, replication:null, group_key:null, strategy:null,
  asset_class:null, region:null, domicile_country:null, instrument:null, hedged:0,
  source:'justetf', fetched_at:null,
};

const upsertEtf = (etf) => {
  const row = { ...ETFS_DEFAULTS, ...etf };
  getDb().prepare(`
    INSERT INTO etfs (isin,name,ticker,currency,ter,aum_mln,dividends,n_holdings,
                      perf_1m,perf_3m,perf_6m,perf_12m,volatility,mdd12m,replication,
                      group_key,strategy,asset_class,region,domicile_country,
                      instrument,hedged,source,fetched_at)
    VALUES (@isin,@name,@ticker,@currency,@ter,@aum_mln,@dividends,@n_holdings,
            @perf_1m,@perf_3m,@perf_6m,@perf_12m,@volatility,@mdd12m,@replication,
            @group_key,@strategy,@asset_class,@region,@domicile_country,
            @instrument,@hedged,@source,@fetched_at)
    ON CONFLICT(isin) DO UPDATE SET
      name=excluded.name, ticker=excluded.ticker, currency=excluded.currency,
      ter=excluded.ter, aum_mln=excluded.aum_mln, dividends=excluded.dividends,
      n_holdings=excluded.n_holdings, perf_1m=excluded.perf_1m, perf_3m=excluded.perf_3m,
      perf_6m=excluded.perf_6m, perf_12m=excluded.perf_12m, volatility=excluded.volatility,
      mdd12m=excluded.mdd12m, replication=excluded.replication, group_key=excluded.group_key,
      strategy=excluded.strategy, asset_class=excluded.asset_class,
      region=excluded.region, domicile_country=excluded.domicile_country,
      instrument=excluded.instrument, hedged=excluded.hedged,
      source=excluded.source, fetched_at=excluded.fetched_at
  `).run(row);
};

const upsertEtfsBatch = (etfs) => getDb().transaction(rows => rows.forEach(upsertEtf))(etfs);
const getAllEtfs       = () => getDb().prepare('SELECT * FROM etfs').all();
const getEtfsByGroupKey = (key) => getDb().prepare('SELECT * FROM etfs WHERE group_key=?').all(key);
const getEtfByIsin      = (isin) => getDb().prepare('SELECT * FROM etfs WHERE isin=?').get(isin);

/**
 * Usuwa ETF-y danego źródła które zniknęły z danych (np. wycofane z JustETF/GPW).
 * Nigdy nie usuwa ETF-ów oznaczonych jako posiadane.
 * @param {string} source - 'justetf' lub 'atlasetf'
 * @param {string[]} seenIsins - ISINy które były obecne w ostatnim scrape
 * @returns {number} liczba usuniętych wierszy
 */
const cleanupMissingEtfs = (source, seenIsins) => {
  if (!seenIsins.length) return 0;
  const d = getDb();
  const placeholders = seenIsins.map(() => '?').join(',');
  const result = d.prepare(`
    DELETE FROM etfs
    WHERE source = ?
      AND isin NOT IN (${placeholders})
      AND isin NOT IN (SELECT isin FROM owned_etfs)
  `).run(source, ...seenIsins);
  return result.changes;
};

// ── Ranking ───────────────────────────────────────────────────────────────────

const RANKING_DEFAULTS = {
  isin:null, name:null, ticker:null, currency:null, ter:null, aum_mln:null,
  dividends:null, strategy:null,
  asset_class:null, region:null, domicile_country:null, instrument:null, hedged:0,
  r1m_pln:null, r3m_pln:null, r6m_pln:null, r12m_pln:null,
  r12m_skip1m_pln:null, mdd12m:null,
  vol_pln:null, ms_raw:null, ms_adj:null, rank_pos:null,
  abs_ok:0, buy_signal:0, watch_zone:0,
  ignored:0, owned:0, group_key:null, group_size:1, is_override:0, computed_at:null,
};

const saveRanking = (rows) => {
  const d = getDb();
  const ins = d.prepare(`
    INSERT INTO ranking (isin,name,ticker,currency,ter,aum_mln,dividends,strategy,
                         asset_class,region,domicile_country,instrument,hedged,
                         r1m_pln,r3m_pln,r6m_pln,r12m_pln,r12m_skip1m_pln,mdd12m,
                         vol_pln,ms_raw,ms_adj,
                         rank_pos,abs_ok,buy_signal,watch_zone,ignored,owned,group_key,group_size,is_override,computed_at)
    VALUES (@isin,@name,@ticker,@currency,@ter,@aum_mln,@dividends,@strategy,
            @asset_class,@region,@domicile_country,@instrument,@hedged,
            @r1m_pln,@r3m_pln,@r6m_pln,@r12m_pln,@r12m_skip1m_pln,@mdd12m,
            @vol_pln,@ms_raw,@ms_adj,
            @rank_pos,@abs_ok,@buy_signal,@watch_zone,@ignored,@owned,@group_key,@group_size,@is_override,@computed_at)
  `);
  d.transaction(() => {
    d.prepare('DELETE FROM ranking').run();
    rows.forEach(r => ins.run({ ...RANKING_DEFAULTS, ...r }));
  })();
};

const getRanking = () =>
  getDb().prepare(`
    SELECT * FROM ranking
    ORDER BY CASE WHEN rank_pos IS NULL THEN 999999 ELSE rank_pos END, ms_adj DESC
  `).all();

const getRankingMeta = () =>
  getDb().prepare('SELECT computed_at, COUNT(*) as total FROM ranking WHERE ignored=0').get();

// ── Ignored ───────────────────────────────────────────────────────────────────

const addIgnored    = (isin) =>
  getDb().prepare(`INSERT INTO ignored_etfs(isin,ignored_at) VALUES(?,?)
    ON CONFLICT(isin) DO UPDATE SET ignored_at=excluded.ignored_at`)
    .run(isin, new Date().toISOString());

const removeIgnored = (isin) => getDb().prepare('DELETE FROM ignored_etfs WHERE isin=?').run(isin);
const getIgnoredIsins = () => getDb().prepare('SELECT isin FROM ignored_etfs').all().map(r => r.isin);

const getIgnoredList = () => {
  const d = getDb();
  const ignored = d.prepare('SELECT isin, ignored_at FROM ignored_etfs ORDER BY ignored_at DESC').all();
  return ignored.map(({ isin, ignored_at }) => {
    let etf = null, rank = null;
    try { etf  = d.prepare('SELECT * FROM etfs WHERE isin=?').get(isin); } catch(e) {}
    try { rank = d.prepare('SELECT * FROM ranking WHERE isin=?').get(isin); } catch(e) {}
    return {
      isin, ignored_at,
      name:            rank?.name            ?? etf?.name            ?? null,
      ticker:          rank?.ticker          ?? etf?.ticker          ?? null,
      currency:        rank?.currency        ?? etf?.currency        ?? null,
      ter:             rank?.ter             ?? etf?.ter             ?? null,
      aum_mln:         rank?.aum_mln         ?? etf?.aum_mln         ?? null,
      dividends:       rank?.dividends       ?? etf?.dividends       ?? null,
      strategy:        rank?.strategy        ?? etf?.strategy        ?? null,
      group_key:       rank?.group_key       ?? etf?.group_key       ?? null,
      rank_pos:        rank?.rank_pos        ?? null,
      ms_adj:          rank?.ms_adj          ?? null,
      ms_raw:          rank?.ms_raw          ?? null,
      r1m_pln:         rank?.r1m_pln         ?? null,
      r3m_pln:         rank?.r3m_pln         ?? null,
      r6m_pln:         rank?.r6m_pln         ?? null,
      r12m_pln:        rank?.r12m_pln        ?? null,
      r12m_skip1m_pln: rank?.r12m_skip1m_pln ?? null,
      mdd12m:          rank?.mdd12m          ?? null,
      vol_pln:         rank?.vol_pln         ?? null,
    };
  });
};

// ── Owned ─────────────────────────────────────────────────────────────────────

const addOwned = (isin, notes = null) =>
  getDb().prepare(`INSERT INTO owned_etfs(isin,bought_at,notes) VALUES(?,?,?)
    ON CONFLICT(isin) DO UPDATE SET bought_at=excluded.bought_at,notes=excluded.notes`)
    .run(isin, new Date().toISOString(), notes);

const removeOwned   = (isin) => getDb().prepare('DELETE FROM owned_etfs WHERE isin=?').run(isin);
const getOwnedIsins = () => new Set(getDb().prepare('SELECT isin FROM owned_etfs').all().map(r => r.isin));

const getOwnedList = () => {
  const d = getDb();
  const owned = d.prepare('SELECT isin, bought_at FROM owned_etfs ORDER BY bought_at DESC').all();
  return owned.map(({ isin, bought_at }) => {
    let etf = null, rank = null;
    try { etf  = d.prepare('SELECT * FROM etfs    WHERE isin=?').get(isin); } catch(e) {}
    try { rank = d.prepare('SELECT * FROM ranking WHERE isin=?').get(isin); } catch(e) {}
    return {
      isin, bought_at,
      name:            rank?.name            ?? etf?.name            ?? null,
      ticker:          rank?.ticker          ?? etf?.ticker          ?? null,
      currency:        rank?.currency        ?? etf?.currency        ?? null,
      ter:             rank?.ter             ?? etf?.ter             ?? null,
      aum_mln:         rank?.aum_mln         ?? etf?.aum_mln         ?? null,
      dividends:       rank?.dividends       ?? etf?.dividends       ?? null,
      strategy:        rank?.strategy        ?? etf?.strategy        ?? null,
      group_key:       rank?.group_key       ?? etf?.group_key       ?? null,
      rank_pos:        rank?.rank_pos        ?? null,
      ms_adj:          rank?.ms_adj          ?? null,
      ms_raw:          rank?.ms_raw          ?? null,
      r1m_pln:         rank?.r1m_pln         ?? null,
      r3m_pln:         rank?.r3m_pln         ?? null,
      r6m_pln:         rank?.r6m_pln         ?? null,
      r12m_pln:        rank?.r12m_pln        ?? null,
      r12m_skip1m_pln: rank?.r12m_skip1m_pln ?? null,
      mdd12m:          rank?.mdd12m          ?? null,
      vol_pln:         rank?.vol_pln         ?? null,
    };
  });
};

// ── Group overrides ───────────────────────────────────────────────────────────

const setGroupOverride   = (gk, isin) =>
  getDb().prepare(`INSERT INTO group_overrides(group_key,rep_isin,set_at) VALUES(?,?,?)
    ON CONFLICT(group_key) DO UPDATE SET rep_isin=excluded.rep_isin,set_at=excluded.set_at`)
    .run(gk, isin, new Date().toISOString());

const clearGroupOverride = (gk) => getDb().prepare('DELETE FROM group_overrides WHERE group_key=?').run(gk);
const getGroupOverrides  = () => {
  const rows = getDb().prepare('SELECT group_key, rep_isin FROM group_overrides').all();
  return Object.fromEntries(rows.map(r => [r.group_key, r.rep_isin]));
};

// ── FX Rates ──────────────────────────────────────────────────────────────────

const saveFxRate = (currency, period, rate, date) =>
  getDb().prepare(`INSERT INTO fx_rates(currency,period,rate,date) VALUES(?,?,?,?)
    ON CONFLICT(currency,period) DO UPDATE SET rate=excluded.rate,date=excluded.date`)
    .run(currency, period, rate, date);

const getFxRate = (currency, period) => {
  const row = getDb().prepare('SELECT rate FROM fx_rates WHERE currency=? AND period=?').get(currency, period);
  return row ? row.rate : null;
};

// ── Job Log ───────────────────────────────────────────────────────────────────

const startJob   = () =>
  getDb().prepare(`INSERT INTO job_log(started_at,status) VALUES(?,'running')`)
    .run(new Date().toISOString()).lastInsertRowid;

const finishJob  = (id, status, n, err = null) =>
  getDb().prepare(`UPDATE job_log SET finished_at=?,status=?,etfs_fetched=?,error_msg=? WHERE id=?`)
    .run(new Date().toISOString(), status, n, err, id);

const getLastJob    = () => getDb().prepare('SELECT * FROM job_log ORDER BY id DESC LIMIT 1').get();
const getJobHistory = (n = 20) => getDb().prepare('SELECT * FROM job_log ORDER BY id DESC LIMIT ?').all(n);

// ── Broker ISINs ──────────────────────────────────────────────────────────────

/**
 * Zapisuje listę ISINów dla danego brokera (zastępuje poprzednie dane).
 * @param {string} broker - np. 'xtb', 'bossa'
 * @param {string[]} isins
 */
const saveBrokerIsins = (broker, isins) => {
  const d = getDb();
  const now = new Date().toISOString();
  d.transaction(() => {
    d.prepare('DELETE FROM broker_isins WHERE broker=?').run(broker);
    const ins = d.prepare('INSERT INTO broker_isins(broker,isin,fetched_at) VALUES(?,?,?)');
    for (const isin of isins) ins.run(broker, isin, now);
    d.prepare(`INSERT INTO broker_updates(broker,last_run_at,status,isin_count,error_msg)
      VALUES(?,?,?,?,?) ON CONFLICT(broker) DO UPDATE SET
      last_run_at=excluded.last_run_at, status=excluded.status,
      isin_count=excluded.isin_count, error_msg=excluded.error_msg`)
      .run(broker, now, 'ok', isins.length, null);
  })();
};

const saveBrokerError = (broker, errMsg) => {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO broker_updates(broker,last_run_at,status,isin_count,error_msg)
    VALUES(?,?,?,?,?) ON CONFLICT(broker) DO UPDATE SET
    last_run_at=excluded.last_run_at, status=excluded.status, error_msg=excluded.error_msg`)
    .run(broker, now, 'error', 0, errMsg);
};

/** Zwraca Set ISINów dostępnych u danego brokera. */
const getBrokerIsins = (broker) =>
  new Set(getDb().prepare('SELECT isin FROM broker_isins WHERE broker=?').all(broker).map(r => r.isin));

/**
 * Zwraca mapę { broker → Set<isin> } dla wszystkich brokerów.
 * Ładowana raz per request dla wydajności.
 */
const getAllBrokerIsins = () => {
  const rows = getDb().prepare('SELECT broker, isin FROM broker_isins').all();
  const map = {};
  for (const { broker, isin } of rows) {
    if (!map[broker]) map[broker] = new Set();
    map[broker].add(isin);
  }
  return map;
};

/** Zwraca status ostatnich aktualizacji brokerów. */
const getBrokerUpdates = () =>
  getDb().prepare('SELECT * FROM broker_updates ORDER BY broker').all();

module.exports = {
  getDb, upsertEtfsBatch, getAllEtfs, getEtfsByGroupKey, getEtfByIsin, cleanupMissingEtfs,
  saveRanking, getRanking, getRankingMeta,
  addIgnored, removeIgnored, getIgnoredIsins, getIgnoredList,
  addOwned, removeOwned, getOwnedIsins, getOwnedList,
  setGroupOverride, clearGroupOverride, getGroupOverrides,
  saveFxRate, getFxRate,
  startJob, finishJob, getLastJob, getJobHistory,
  saveBrokerIsins, saveBrokerError, getBrokerIsins, getAllBrokerIsins, getBrokerUpdates,
};
