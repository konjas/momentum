const { spawn } = require('child_process');
const path = require('path');
const { upsertEtfsBatch } = require('./database');
const log = (...a) => console.log('[SCRAPER]', ...a);

async function runPythonScript(scriptName, args, excludes) {
  let total = 0, saved = 0;
  const batch = [];
  const fetched_at = new Date().toISOString();

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
          if (etf.isin && !excludes.has(etf.isin)) batch.push({ ...etf, fetched_at });
        } catch (_) {}
      }
      if (code !== 0) return reject(new Error(`${scriptName} exit ${code}`));
      resolve();
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });

  if (batch.length) upsertEtfsBatch(batch);
  return { total, saved };
}

async function runScraper(config) {
  const maxEtfs  = config.scraper?.maxEtfs ?? 10000;
  const excludes = new Set(config.filters?.excludeIsins ?? []);

  // 1. JustETF
  log(`Scraping JustETF (max ${maxEtfs})...`);
  const { total: t1, saved: s1 } = await runPythonScript('fetch_etfs.py', [String(maxEtfs)], excludes);
  log(`JustETF: ${s1} ETFów (z ${t1})`);

  // 2. Polskie ETF/ETC/ETN (GPW + AtlasETF + Stooq)
  log('Scraping polskich ETFów (GPW + AtlasETF + Stooq)...');
  try {
    const { total: t2, saved: s2 } = await runPythonScript('fetch_pl_etfs.py', [], excludes);
    log(`Polskie ETFy: ${s2} instrumentów (z ${t2})`);
  } catch (err) {
    log(`[WARN] Polskie ETFy: ${err.message} — kontynuuję bez nich`);
  }

  return s1;
}

module.exports = { runScraper };
