const cron = require('node-cron');
const { fetchAndSaveFxRates } = require('./nbp');
const { runScraper } = require('./scraper');
const { computeRanking } = require('./ranking');
const { startJob, finishJob } = require('./database');

const log = (...a) => console.log('[SCHEDULER]', ...a);
let isRunning = false;
let lastRunResult = null;

async function runFullUpdate(config) {
  if (isRunning) return { skipped: true };
  isRunning = true;
  const jobId = startJob();
  const t0 = Date.now();
  log(`=== Start runa (job #${jobId}) ===`);
  try {
    log('1/3: Kursy walut NBP');
    await fetchAndSaveFxRates();
    log('2/3: Scraping JustETF');
    const etfCount = await runScraper(config);
    log('3/3: Obliczanie rankingu');
    computeRanking(config);
    const elapsed = Math.round((Date.now()-t0)/1000);
    log(`=== Gotowe (${elapsed}s, ${etfCount} ETFów) ===`);
    finishJob(jobId, 'ok', etfCount);
    lastRunResult = { status:'ok', jobId, etfCount, elapsed, finishedAt:new Date().toISOString() };
    return lastRunResult;
  } catch(err) {
    const elapsed = Math.round((Date.now()-t0)/1000);
    log(`=== FAILED (${elapsed}s): ${err.message} ===`);
    finishJob(jobId, 'error', null, err.message);
    lastRunResult = { status:'error', jobId, error:err.message, elapsed, finishedAt:new Date().toISOString() };
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

function recomputeRankingOnly(config) {
  const count = computeRanking(config);
  log(`[RECOMPUTE] Gotowe: ${count} aktywnych ETFów`);
  return count;
}

function startCron(config) {
  const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
  log(`Cron: "${schedule}" UTC`);
  cron.schedule(schedule, () => runFullUpdate(config), { timezone:'UTC' });
}

function getStatus() { return { isRunning, lastRunResult }; }

module.exports = { runFullUpdate, recomputeRankingOnly, startCron, getStatus };
