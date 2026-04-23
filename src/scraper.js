const { spawn } = require('child_process');
const path = require('path');
const { upsertEtfsBatch, saveBrokerIsins, saveBrokerError, cleanupMissingEtfs } = require('./database');
const log = (...a) => console.log('[SCRAPER]', ...a);

async function runPythonScript(scriptName, args, excludes = new Set()) {
  let total = 0, saved = 0;
  const batch = [];
  const fetched_at = new Date().toISOString();
  const seenIsins = [];  // zbieramy wszystkie ISINy z tego skryptu

  await new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      path.join('/app/src', scriptName),
      ...args,
    ], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    let buf = '';
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => log(`[${scriptName}] ${l}`)));

    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const etf = JSON.parse(line);
          if (!etf.isin || etf.isin.length !== 12) continue;
          total++;
          seenIsins.push(etf.isin);
          if (excludes.has(etf.isin)) continue;
          batch.push({ ...etf, fetched_at });
          saved++;
          if (batch.length >= 100) upsertEtfsBatch(batch.splice(0, 100));
        } catch (_) {}
      }
    });

    const timeout = scriptName === 'fetch_pl_etfs.py' ? 600000 : 300000;
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Timeout ${scriptName}`)); }, timeout);
    proc.on('close', code => {
      clearTimeout(timer);
      if (buf.trim()) {
        try {
          const etf = JSON.parse(buf.trim());
          if (etf.isin && etf.isin.length === 12) {
            seenIsins.push(etf.isin);
            if (!excludes.has(etf.isin)) batch.push({ ...etf, fetched_at });
          }
        } catch (_) {}
      }
      if (code !== 0) return reject(new Error(`${scriptName} exit ${code}`));
      resolve();
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });

  if (batch.length) upsertEtfsBatch(batch);
  return { total, saved, seenIsins };
}

async function runScraper(config) {
  const maxEtfs  = config.scraper?.maxEtfs ?? 10000;
  const excludes = new Set(config.filters?.excludeIsins ?? []);

  // 1. JustETF
  log(`Scraping JustETF (max ${maxEtfs})...`);
  const { total: t1, saved: s1, seenIsins: justetfIsins } = await runPythonScript('fetch_etfs.py', [String(maxEtfs)], excludes);
  log(`JustETF: ${s1} ETFów (z ${t1})`);
  // Usuń ETF-y wycofane z JustETF (pomijając posiadane)
  if (justetfIsins.length > 0) {
    const removed = cleanupMissingEtfs('justetf', justetfIsins);
    if (removed > 0) log(`Usunięto ${removed} wycofanych ETFów z JustETF`);
  }

  // 2. Polskie ETF/ETC/ETN (GPW + AtlasETF + yfinance)
  log('Scraping polskich ETFów (GPW + AtlasETF + yfinance)...');
  try {
    const { total: t2, saved: s2, seenIsins: plIsins } = await runPythonScript('fetch_pl_etfs.py', [], excludes);
    log(`Polskie ETFy: ${s2} instrumentów (z ${t2})`);
    // Usuń polskie ETF-y które zniknęły z GPW (pomijając posiadane)
    if (plIsins.length > 0) {
      const removed = cleanupMissingEtfs('atlasetf', plIsins);
      if (removed > 0) log(`Usunięto ${removed} wycofanych ETFów z GPW`);
    }
  } catch (err) {
    log(`[WARN] Polskie ETFy: ${err.message} — kontynuuję bez nich`);
  }

  return s1;
}

/**
 * Pobiera dane o dostępności ETF-ów u brokerów i zapisuje do bazy.
 * Uruchamia fetch_brokers.py i parsuje wynik NDJSON.
 */
async function runBrokerScraper() {
  log('=== Aktualizacja danych brokerów ===');
  const brokerData = {};  // { broker → isin[] }

  await new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      path.join('/app/src', 'fetch_brokers.py'),
    ], { env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    let buf = '';
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => log(`[fetch_brokers] ${l}`)));

    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const { broker, isin } = JSON.parse(line);
          if (!broker || !isin || isin.length !== 12) continue;
          if (!brokerData[broker]) brokerData[broker] = [];
          brokerData[broker].push(isin);
        } catch (_) {}
      }
    });

    const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout fetch_brokers.py')); }, 120000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`fetch_brokers.py exit ${code}`));
      resolve();
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });

  // Zapisz dane per broker
  for (const [broker, isins] of Object.entries(brokerData)) {
    saveBrokerIsins(broker, isins);
    log(`Broker ${broker.toUpperCase()}: ${isins.length} ISINów zapisanych`);
  }

  // Zapisz błąd dla brokerów które nie zwróciły danych
  const expectedBrokers = ['xtb', 'bossa', 'mbank'];
  for (const broker of expectedBrokers) {
    if (!brokerData[broker]) {
      saveBrokerError(broker, 'Brak danych z fetch_brokers.py');
      log(`[WARN] Brak danych dla brokera ${broker}`);
    }
  }

  return brokerData;
}

module.exports = { runScraper, runBrokerScraper };
