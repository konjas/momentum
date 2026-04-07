/**
 * nbp.js — Pobieranie kursów walut z oficjalnego API NBP
 *
 * API NBP: https://api.nbp.pl/
 * Używamy tabeli A (kursy średnie) dla walut: EUR, USD, GBP, CHF
 *
 * Dla każdej waluty potrzebujemy kursu:
 *   - 'now'  — dziś (lub ostatni dostępny dzień sesyjny)
 *   - '1m'   — 1 miesiąc temu
 *   - '3m'   — 3 miesiące temu
 *   - '6m'   — 6 miesięcy temu
 *   - '12m'  — 12 miesięcy temu
 *
 * Używane do przeliczenia stóp zwrotu ETFów na PLN:
 *   R_PLN = (1 + R_waluta) × (kurs_teraz / kurs_N_miesięcy_temu) - 1
 */

const axios = require('axios');
const { saveFxRate, getFxRate } = require('./database');

const NBP_BASE = 'https://api.nbp.pl/api/exchangerates/rates/a';
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

// NBP API /last/{N} akceptuje max 255 rekordów
// 255 dni sesyjnych ≈ ~13 miesięcy — wystarczy na R12M
const HISTORY_DAYS = 255;

const log = (...args) => console.log('[NBP]', ...args);

/**
 * Pobierz wszystkie kursy walut z NBP i zapisz do bazy.
 * Wywołuje się raz na każdy run scrapera.
 */
async function fetchAndSaveFxRates() {
  log('Pobieranie kursów walut PLN z NBP...');

  for (const currency of CURRENCIES) {
    try {
      const rates = await fetchRateHistory(currency, HISTORY_DAYS);
      if (!rates || rates.length === 0) {
        log(`  WARN: brak danych dla ${currency}`);
        continue;
      }

      // Posortuj rosnąco po dacie
      rates.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

      const now     = rates[rates.length - 1];
      const ago1m   = findClosestRate(rates, monthsAgo(1));
      const ago3m   = findClosestRate(rates, monthsAgo(3));
      const ago6m   = findClosestRate(rates, monthsAgo(6));
      const ago12m  = findClosestRate(rates, monthsAgo(12));

      saveFxRate(currency, 'now',  now.mid,   now.effectiveDate);
      saveFxRate(currency, '1m',   ago1m.mid, ago1m.effectiveDate);
      saveFxRate(currency, '3m',   ago3m.mid, ago3m.effectiveDate);
      saveFxRate(currency, '6m',   ago6m.mid, ago6m.effectiveDate);
      saveFxRate(currency, '12m',  ago12m.mid, ago12m.effectiveDate);

      log(`  ${currency}: now=${now.mid.toFixed(4)} PLN (${now.effectiveDate}), ` +
          `12m_ago=${ago12m.mid.toFixed(4)} PLN (${ago12m.effectiveDate})`);

    } catch (err) {
      log(`  ERROR dla ${currency}:`, err.message);
    }
  }

  log('Kursy walut zapisane.');
}

/**
 * Pobierz historię kursów dla jednej waluty (ostatnie N dni).
 */
async function fetchRateHistory(currency, days) {
  const url = `${NBP_BASE}/${currency.toLowerCase()}/last/${days}/?format=json`;

  try {
    const resp = await axios.get(url, { timeout: 10000 });
    return resp.data?.rates || [];
  } catch (err) {
    if (err.response?.status === 404) {
      log(`  ${currency} niedostępna w tabeli A NBP`);
      return [];
    }
    throw err;
  }
}

/**
 * Znajdź kurs najbliższy zadanej dacie (wstecz).
 * NBP nie publikuje kursów w weekendy i święta.
 */
function findClosestRate(rates, targetDate) {
  const targetStr = targetDate.toISOString().split('T')[0];

  // Znajdź ostatni dostępny dzień <= targetDate
  let closest = rates[0];
  for (const rate of rates) {
    if (rate.effectiveDate <= targetStr) {
      closest = rate;
    } else {
      break;
    }
  }
  return closest;
}

/**
 * Data N miesięcy temu.
 */
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

/**
 * Przelicz stopę zwrotu ETFa z waluty X na PLN.
 *
 * @param {number} returnInCurrency  - stopa zwrotu w walucie ETFa (np. 0.15 = 15%)
 * @param {string} currency          - waluta ETFa ('EUR', 'USD', itp.)
 * @param {string} period            - horyzont ('1m', '3m', '6m', '12m')
 * @returns {number|null}            - stopa zwrotu w PLN lub null jeśli brak danych
 */
function convertReturnToPLN(returnInCurrency, currency, period) {
  if (returnInCurrency == null) return null;

  // EUR → PLN: ETF w EUR = bezpośrednia konwersja
  // Większość UCITS ETFów notowana jest w EUR
  const rateNow = getFxRate(currency, 'now');
  const rateOld = getFxRate(currency, period);

  if (!rateNow || !rateOld) {
    // Brak kursu dla tej waluty — zwróć oryginalną stopę
    // (dotyczy rzadkich walut; EUR/USD/GBP/CHF powinny być zawsze dostępne)
    return returnInCurrency;
  }

  const fxReturn = rateNow / rateOld - 1;
  const plnReturn = (1 + returnInCurrency) * (1 + fxReturn) - 1;
  return plnReturn;
}

module.exports = {
  fetchAndSaveFxRates,
  convertReturnToPLN,
  CURRENCIES,
};
