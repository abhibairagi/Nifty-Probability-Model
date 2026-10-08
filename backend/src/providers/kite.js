// Kite (Zerodha) web session: the user pastes a "Copy as cURL" of any kite.zerodha.com/oms request once a day;
// we keep the enctoken + cookies for the day and call the chart-history endpoint with them.
//
//   GET https://kite.zerodha.com/oms/instruments/historical/<token>/<interval>?user_id=…&oi=1&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → { status: "success", data: { candles: [[ "2026-10-05T09:15:00+0530", open, high, low, close, volume, oi ], …] } }
//
// Used now for INDIA VIX (instrument token 264969).

import { parseCurlCommand, cookieValue, cookieNames, readSecret, writeSecret, removeSecret } from './curlSession.js';

const BASE = 'https://kite.zerodha.com/oms/instruments/historical';
export const KITE_TOKENS = { INDIA_VIX: 264969, NIFTY_50: 256265, SENSEX: 265 };

export function parseKiteCurl(text) {
  const { url, headers, cookie } = parseCurlCommand(text);
  if (url && !/kite\.zerodha\.com/.test(url)) throw new Error('this is not a kite.zerodha.com request');
  const enctoken = headers.authorization?.match(/^enctoken\s+(.+)$/i)?.[1] ?? cookieValue(cookie, 'enctoken');
  if (!enctoken) throw new Error('no enctoken found — copy the curl while logged in to Kite (the request needs an "authorization: enctoken …" header)');
  const userId = cookieValue(cookie, 'user_id') ?? (url ? new URL(url).searchParams.get('user_id') : null);
  if (!userId) throw new Error('no user_id found in the curl');
  return { headers: { ...headers, authorization: `enctoken ${enctoken}` }, cookie, userId };
}

let lastResult = null;

export function loadKiteSession() {
  return readSecret('kite');
}

/** Saves the session after a test call so a bad paste is rejected immediately. */
export async function saveKiteSessionFromCurl(text) {
  const parsed = parseKiteCurl(text);
  const session = { savedAt: new Date().toISOString(), ...parsed };
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const candles = await historical(KITE_TOKENS.INDIA_VIX, 'day', today, today, session).catch((e) => {
    throw new Error(`Kite rejected the session: ${e.message}`);
  });
  writeSecret('kite', session);
  lastResult = { ok: true, at: new Date().toISOString(), vix: candles.at(-1)?.close ?? null };
  return kiteStatus();
}

export function clearKiteSession() {
  removeSecret('kite');
  lastResult = null;
}

export function kiteStatus() {
  const s = loadKiteSession();
  if (!s) return { configured: false, lastResult };
  return { configured: true, savedAt: s.savedAt, userId: s.userId, cookieNames: cookieNames(s.cookie), lastResult };
}

/** Candles as { t (ms), open, high, low, close, volume, oi }. Dates are IST calendar dates. */
export async function historical(token, interval, from, to, session = loadKiteSession()) {
  if (!session) throw new Error('no Kite session — paste a Kite curl on the Data Sessions page');
  const url = `${BASE}/${token}/${interval}?user_id=${encodeURIComponent(session.userId)}&oi=1&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: { ...session.headers, cookie: session.cookie }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 401) throw new Error(`Kite ${res.status}: session expired — paste a fresh Kite curl`);
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status !== 'success') throw new Error(`Kite HTTP ${res.status}: ${j?.message ?? 'unexpected response'}`);
  return j.data.candles.map(([ts, open, high, low, close, volume, oi]) => ({
    t: new Date(ts.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime(),
    open,
    high,
    low,
    close,
    volume,
    oi,
  }));
}

// Kite allows ~3 historical requests per second; every call goes through this queue.
let queue = Promise.resolve();
const GAP_MS = 350;
function throttled(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP_MS)));
  return run;
}

/**
 * Minute candles per instrument for a day, cached. `candleAt(token, tsMs)` returns the last 1-minute candle at or
 * before that time, plus the day's volume up to it. An instrument is refetched only when asked for a time newer than
 * its cache holds, and at most every 30 s.
 */
export function createCandleCache({ minRefetchMs = 30_000 } = {}) {
  const cache = new Map(); // `${token}|${date}` → { candles, fetchedAt }
  const inflight = new Map(); // `${token}|${date}` → Promise — concurrent callers share one request

  async function load(token, date, needMs) {
    const key = `${token}|${date}`;
    const c = cache.get(key);
    const fresh = c && (c.candles.at(-1)?.t ?? 0) >= needMs - 60_000;
    if (fresh || (c && Date.now() - c.fetchedAt < minRefetchMs)) return c.candles;
    if (inflight.has(key)) return inflight.get(key);
    const p = throttled(() => historical(token, 'minute', date, date))
      .then((candles) => {
        cache.set(key, { candles, fetchedAt: Date.now() });
        return candles;
      })
      .catch((e) => {
        cache.set(key, { candles: c?.candles ?? [], fetchedAt: Date.now() });
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async candleAt(token, tsMs) {
      const date = new Date(tsMs + 5.5 * 3600e3).toISOString().slice(0, 10);
      const candles = await load(token, date, tsMs);
      let hit = null;
      let volume = 0;
      for (const c of candles) {
        if (c.t > tsMs) break;
        hit = c;
        volume += c.volume ?? 0;
      }
      return hit ? { ...hit, dayVolume: volume } : null;
    },
    reset: () => cache.clear(),
  };
}

/** India VIX at a time (close of the last 1-minute candle at or before it), or null without a Kite session. */
export function createVixSource(candles = createCandleCache()) {
  return {
    async at(tsMs) {
      if (!loadKiteSession()) return null;
      try {
        const c = await candles.candleAt(KITE_TOKENS.INDIA_VIX, tsMs);
        lastResult = { ok: true, at: new Date().toISOString(), vix: c?.close ?? null };
        return c?.close ?? null;
      } catch (e) {
        lastResult = { ok: false, at: new Date().toISOString(), error: e.message };
        return null;
      }
    },
    reset: () => candles.reset(),
  };
}
