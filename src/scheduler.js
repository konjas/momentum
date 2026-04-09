const cron = require('node-cron');
const { fetchAndSaveFxRates } = require('./nbp');
const { runScraper, runBrokerScraper } = require('./scraper');
const { computeRanking } = require('./ranking');
const { startJob, finishJob } = require('./database');

const log = (...a) => console.log('[SCHEDULER]', ...a);
let isRunning = false;
let isBrokerRunning = false;
let lastRunResult = null;
let lastBrokerResult = null;

async function runFullUpdate(config) {
  if (isRunning) return { skipped: true };
  isRunning = true;
  const jobId = startJob();
  const t0 = Date.now();
  log(`=== Start runa (job #${jobId}) ===`);
  try {
    log('1/3: Kursy walut NBP');
    await fetchAndSaveFxRates();
    log('2/3: Scraping JustETF + polskie ETF-y');
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

async function runBrokerUpdate(config) {
  if (isBrokerRunning) return { skipped: true };
  isBrokerRunning = true;
  const t0 = Date.now();
  log('=== Start aktualizacji brokerów ===');
  try {
    const brokerData = await runBrokerScraper();
    // Po aktualizacji brokerów przelicz ranking (może zmienić się filtr)
    computeRanking(config);
    const elapsed = Math.round((Date.now()-t0)/1000);
    const summary = Object.fromEntries(
      Object.entries(brokerData).map(([b, isins]) => [b, isins.length])
    );
    log(`=== Brokerzy zaktualizowani (${elapsed}s):`, JSON.stringify(summary));
    lastBrokerResult = { status:'ok', elapsed, summary, finishedAt:new Date().toISOString() };
    return lastBrokerResult;
  } catch(err) {
    const elapsed = Math.round((Date.now()-t0)/1000);
    log(`=== Broker update FAILED (${elapsed}s): ${err.message}`);
    lastBrokerResult = { status:'error', error:err.message, elapsed, finishedAt:new Date().toISOString() };
    return lastBrokerResult;
  } finally {
    isBrokerRunning = false;
  }
}

function recomputeRankingOnly(config) {
  const count = computeRanking(config);
  log(`[RECOMPUTE] Gotowe: ${count} aktywnych ETFów`);
  return count;
}

function startCron(config) {
  // Codzienna aktualizacja ETF-ów
  const etfSchedule = process.env.CRON_SCHEDULE || '0 7 * * *';
  log(`ETF cron: "${etfSchedule}" UTC`);
  cron.schedule(etfSchedule, () => runFullUpdate(config), { timezone: 'UTC' });

  // Miesięczna aktualizacja brokerów — 1. dnia miesiąca o 06:00 UTC
  const brokerSchedule = process.env.CRON_BROKERS || '0 6 1 * *';
  log(`Broker cron: "${brokerSchedule}" UTC`);
  cron.schedule(brokerSchedule, () => runBrokerUpdate(config), { timezone: 'UTC' });
}

function getStatus() {
  return { isRunning, lastRunResult, isBrokerRunning, lastBrokerResult };
}

module.exports = { runFullUpdate, runBrokerUpdate, recomputeRankingOnly, startCron, getStatus };
