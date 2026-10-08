// Sensibull "compute_intraday": live ATM IV, IVP, rolling ATM straddle, India VIX, PCR and max pain for the
// CURRENT expiry only (the nearest expiry on/after today; on expiry day it rolls to the next one after 15:30).
// Polled every minute during market hours with the same daily Sensibull session as the OI feed.
//
//   POST https://oxide.sensibull.com/v1/compute/compute_intraday
//   → { success, payload: { server_atm_strikes_map: { "<expiry>": atm, … },
//        chart_data: { "<ISO bar time>": { spot, iv: { atm_iv, atm_strike }, ivp: { ivp }, indiavix: { indiavix_price },
//                                          pcr_data: { pcr }, max_pain_data: { max_pain },
//                                          rolling_atm_straddle: { "<expiry>": { atm_strike, ltp } } }, … } } }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, STD_HEADERS } from './sensibullSession.js';
import { optionExpiries } from './kiteInstruments.js';
import { nextExpiry } from '../instruments.js';

const URL_INTRADAY = 'https://oxide.sensibull.com/v1/compute/compute_intraday';
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const CHART_KEYS = ['iv', 'ivp', 'rolling_atm_straddle', 'indiavix', 'pcr', 'max_pain'];

const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const istHHMM = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);

/** Nearest expiry on/after today; on expiry day, after 15:30 IST, the next one. */
export function currentExpiry(expiries, nowMs = Date.now()) {
  const today = istDate(nowMs);
  const after = istHHMM(nowMs) > '15:30';
  return [...expiries].sort().find((d) => d > today || (d === today && !after)) ?? null;
}

/** Request body asking for the current expiry only. */
export function buildBody(expiry, atm, symbol = 'NIFTY') {
  const only = { [expiry]: { enabled: true } };
  return {
    underlying: symbol,
    interval: '15M',
    chart_keys: CHART_KEYS,
    client_atm_strikes_map: atm ? { [expiry]: atm } : {},
    offset: null,
    iv: { automatic_expiry: false, selection: 'atm_strike', expiries: only, custom_strikes: [] },
    ivp: { automatic_expiry: false, expiries: only },
    rolling_atm_straddle: { price_display: { ltp: true, vwap: false }, expiries: only },
    pcr: { is_custom: false, automatic_expiry: false, strikes_above_atm: 'all', strikes_below_atm: 'all', expiries: only, custom_strikes: [] },
    max_pain: { expiries: only, automatic_expiry: false },
    update_atm: false,
  };
}

/** Today's bars (09:15–15:30 IST) as flat rows, oldest first. Bars after the close (e.g. 19:30) are dropped. */
export function parseIntraday(payload, expiry, date) {
  const rows = [];
  for (const [ts, b] of Object.entries(payload?.chart_data ?? {})) {
    if (!ts.startsWith(date)) continue;
    const hhmm = ts.slice(11, 16);
    if (hhmm < '09:15' || hhmm > '15:30') continue;
    const st = b.rolling_atm_straddle?.[expiry];
    rows.push({
      t: new Date(ts).toISOString(),
      bar: hhmm,
      expiry,
      spot: b.spot ?? null,
      atmIv: b.iv?.atm_iv ?? null,
      atmStrike: b.iv?.atm_strike ?? null,
      ivp: b.ivp?.ivp ?? null,
      vix: b.indiavix?.indiavix_price ?? null,
      pcr: b.pcr_data?.pcr ?? null,
      maxPain: b.max_pain_data?.max_pain ?? null,
      straddle: st?.ltp ?? null,
      straddleStrike: st?.atm_strike ?? null,
    });
  }
  return rows.sort((a, b) => a.t.localeCompare(b.t));
}

// ---- storage: data/<SYMBOL>/sensibull-iv/<date>.json = { date, expiry, bars: [15-min rows], live: [1-min rows] } ----

const fileFor = (symbol, date) => path.join(DATA_DIR, symbol, 'sensibull-iv', `${date}.json`);

export function getIntradayDay(symbol, date = istDate()) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(symbol, date), 'utf8'));
  } catch {
    return null;
  }
}

function saveIntradayDay(symbol, date, data) {
  const f = fileFor(symbol, date);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
  fs.renameSync(`${f}.tmp`, f);
}

/** Latest live reading for a day (the newest 1-minute poll), or null. */
export function latestIntraday(symbol, date = istDate()) {
  return getIntradayDay(symbol, date)?.live?.at(-1) ?? null;
}

const lastResult = {}; // symbol → last poll result
export const intradayStatus = (symbol = 'NIFTY') => lastResult[symbol] ?? null;

export function createIntradayPoller(symbol = 'NIFTY', { seconds = 60, isMarketOpen, force = false, onUpdate, log = console } = {}) {
  let known = []; // expiries the server reported last time
  let atmMap = {};
  let timer = null;

  async function tick({ force: forceNow = false } = {}) {
    const session = loadSession();
    if (!session || (!force && !forceNow && !isMarketOpen())) return;
    const now = Date.now();
    const date = istDate(now);
    const candidates = known.length ? known : optionExpiries(symbol);
    const expiry = currentExpiry(candidates.length ? candidates : [istDate(new Date(nextExpiry(symbol, now)).getTime())], now);
    if (!expiry) return;
    try {
      const res = await fetch(URL_INTRADAY, {
        method: 'POST',
        headers: { ...STD_HEADERS, cookie: session.cookie },
        body: JSON.stringify(buildBody(expiry, atmMap[expiry], symbol)),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error(`Sensibull ${res.status}: session expired — paste a fresh curl`);
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(`Sensibull compute_intraday HTTP ${res.status}`);
      atmMap = j.payload.server_atm_strikes_map ?? atmMap;
      known = Object.keys(atmMap); // the server's expiry list decides the current expiry from the next minute on
      const bars = parseIntraday(j.payload, expiry, date);
      const last = bars.at(-1);
      const day = getIntradayDay(symbol, date) ?? { date, live: [] };
      const live = last ? [...(day.live ?? []).filter((r) => r.t !== new Date(now).toISOString()), { ...last, polledAt: new Date(now).toISOString() }] : day.live ?? [];
      saveIntradayDay(symbol, date, { date, expiry, bars, live: live.slice(-500) });
      lastResult[symbol] = { ok: true, at: new Date().toISOString(), expiry, atmIv: last?.atmIv ?? null, ivp: last?.ivp ?? null, bar: last?.bar ?? null };
      onUpdate?.(date);
    } catch (e) {
      lastResult[symbol] = { ok: false, at: new Date().toISOString(), expiry, error: e.message };
      log.error?.(`[sensibull iv${symbol === 'NIFTY' ? '' : ` ${symbol}`}] ${e.message}`);
    }
  }

  const schedule = () => {
    const period = seconds * 1000;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, period - (Date.now() % period) + 12_000);
  };
  tick();
  schedule();
  return { tickNow: tick, stop: () => clearTimeout(timer) };
}
