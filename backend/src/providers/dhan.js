// Dhan order flow (DEXT charts) — NIFTY futures footprint data, shown on its own Order Flow tab only.
// It is deliberately NOT fed into the probability model (bias, probabilities, ranges).
//
//   POST https://ticks.dhan.co/orderflow/getOrderFlow   header  Auth: <JWT>
//   body { EXCH: "NSE", SEG: "D", SEC_ID: 61471, START: <unix s>, END: <unix s>, START_TIME: ISO, END_TIME: ISO }
//   → { success, data: { instrument, interval: "1m", expiry, candles: [{ t, time, high, low, buy_volume, sell_volume,
//        neutral_volume, total_volume, delta, cumulative_delta, levels: [{ price, buy_volume, sell_volume, … }] }] },
//       nextTime }
//
// The user pastes the request as "Copy as cURL" once a day; the Auth token and the contract (SEC_ID) are kept.
//
// SENSEX futures (BSE) have their own session (secrets/dhan-sensex-session.json) and storage (data/SENSEX/orderflow/);
// NIFTY keeps secrets/dhan-session.json. Every function takes the symbol, defaulting to NIFTY.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCurlCommand, readSecret, writeSecret, removeSecret } from './curlSession.js';

const URL_OF = 'https://ticks.dhan.co/orderflow/getOrderFlow';
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export function parseDhanCurl(text) {
  const { url, headers, body } = parseCurlCommand(text);
  if (url && !/dhan\.co/.test(url)) throw new Error('this is not a dhan.co request');
  const auth = headers.auth;
  if (!auth) throw new Error('no "Auth" header found — copy the getOrderFlow request while logged in to Dhan');
  let req = null;
  try {
    req = JSON.parse(body ?? '');
  } catch {
    throw new Error('could not read the request body (expected JSON with SEC_ID)');
  }
  if (!req?.SEC_ID) throw new Error('request body has no SEC_ID');
  const { auth: _drop, ...rest } = headers;
  return { auth, headers: rest, exch: req.EXCH ?? 'NSE', seg: req.SEG ?? 'D', secId: Number(req.SEC_ID), tokenExpiresAt: jwtExp(auth) };
}

const lastResults = {}; // symbol → last result
const secretName = (symbol) => (symbol === 'SENSEX' ? 'dhan-sensex' : 'dhan');

export function loadDhanSession(symbol = 'NIFTY') {
  return readSecret(secretName(symbol));
}

/** Fetches candles between two unix-second times, following `nextTime` pages. */
export async function fetchOrderFlow(fromSec, toSec, session = loadDhanSession()) {
  if (!session) throw new Error('no Dhan session — paste a Dhan order-flow curl on the Data Sessions page');
  const candles = [];
  let meta = null;
  let start = fromSec;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(URL_OF, {
      method: 'POST',
      headers: { ...session.headers, 'content-type': 'application/json', Auth: session.auth },
      body: JSON.stringify({
        EXCH: session.exch,
        SEG: session.seg,
        SEC_ID: session.secId,
        START: start,
        END: toSec,
        START_TIME: new Date(start * 1000).toISOString(),
        END_TIME: new Date(toSec * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Dhan ${res.status}: session expired — paste a fresh Dhan curl`);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.success) throw new Error(`Dhan HTTP ${res.status}: ${j?.message ?? 'unexpected response'}`);
    meta = { instrument: j.data.instrument, interval: j.data.interval, expiry: j.data.expiry };
    candles.push(...(j.data.candles ?? []));
    if (!j.nextTime || j.nextTime <= start || j.nextTime >= toSec) break;
    start = j.nextTime;
  }
  const byT = new Map(candles.map((c) => [c.t, c]));
  return { ...meta, candles: [...byT.values()].sort((a, b) => a.t - b.t) };
}

/** Saves the session after a test call so a bad paste is rejected immediately. */
export async function saveDhanSessionFromCurl(text, symbol = 'NIFTY') {
  const parsed = parseDhanCurl(text);
  if (symbol === 'SENSEX' && parsed.exch !== 'BSE') throw new Error(`this curl is for an ${parsed.exch} contract — paste the SENSEX futures (BSE) curl here`);
  if (symbol === 'NIFTY' && parsed.exch === 'BSE') throw new Error('this curl is for a BSE (SENSEX) contract — switch the sidebar to SENSEX to paste it, or paste the NIFTY futures (NSE) curl here');
  const session = { savedAt: new Date().toISOString(), ...parsed };
  const now = Math.floor(Date.now() / 1000);
  const probe = await fetchOrderFlow(now - 3600, now, session).catch((e) => {
    throw new Error(`Dhan rejected the session: ${e.message}`);
  });
  writeSecret(secretName(symbol), { ...session, instrument: probe.instrument, expiry: probe.expiry });
  lastResults[symbol] = { ok: true, at: new Date().toISOString(), candles: probe.candles.length };
  return dhanStatus(symbol);
}

export function clearDhanSession(symbol = 'NIFTY') {
  removeSecret(secretName(symbol));
  lastResults[symbol] = null;
}

export function dhanStatus(symbol = 'NIFTY') {
  const s = loadDhanSession(symbol);
  const lastResult = lastResults[symbol] ?? null;
  if (!s) return { configured: false, lastResult };
  const expired = s.tokenExpiresAt ? new Date(s.tokenExpiresAt) < new Date() : false;
  return { configured: true, savedAt: s.savedAt, tokenExpiresAt: s.tokenExpiresAt, expired, secId: s.secId, instrument: s.instrument, expiry: s.expiry, lastResult };
}

// ---- storage: data/<SYMBOL>/orderflow/<date>.json ------------------------------------------------------------

const fileFor = (symbol, date) => path.join(DATA_DIR, symbol, 'orderflow', `${date}.json`);

export function getOrderFlowDay(symbol, date = istDate()) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(symbol, date), 'utf8'));
  } catch {
    return null;
  }
}

function saveOrderFlowDay(symbol, date, data) {
  const f = fileFor(symbol, date);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
  fs.renameSync(`${f}.tmp`, f);
}

/** Pulls today's candles from 09:15 to now and stores them (one request per call). */
export async function syncOrderFlowToday(symbol = 'NIFTY') {
  const date = istDate();
  const open = Math.floor(new Date(`${date}T09:15:00+05:30`).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  try {
    const s = loadDhanSession(symbol);
    const of = await fetchOrderFlow(open, now, s);
    saveOrderFlowDay(symbol, date, { date, secId: s?.secId, fetchedAt: new Date().toISOString(), ...of });
    lastResults[symbol] = { ok: true, at: new Date().toISOString(), candles: of.candles.length, last: of.candles.at(-1)?.time ?? null };
    return of.candles.length;
  } catch (e) {
    lastResults[symbol] = { ok: false, at: new Date().toISOString(), error: e.message };
    throw e;
  }
}

/**
 * Downloads the last `days` weekdays of order flow (one request per day, 1 s apart) for the session's contract,
 * skipping days already stored for the same contract. Days with no trading (holidays) are skipped.
 */
export async function backfillOrderFlowHistory(symbol = 'NIFTY', { days = 15, log = console } = {}) {
  const s = loadDhanSession(symbol);
  if (!s) return 0;
  let added = 0;
  const today = istDate();
  for (let back = 1, seen = 0; seen < days && back < days * 2; back++) {
    const d = istDate(Date.now() - back * 86400e3);
    const wd = new Date(`${d}T12:00:00+05:30`).getUTCDay();
    if (wd === 0 || wd === 6 || d >= today) continue;
    seen++;
    const have = getOrderFlowDay(symbol, d);
    if (have?.secId === s.secId && have.candles?.length) continue;
    const open = Math.floor(new Date(`${d}T09:15:00+05:30`).getTime() / 1000);
    const close = Math.floor(new Date(`${d}T15:30:00+05:30`).getTime() / 1000);
    try {
      const of = await fetchOrderFlow(open, close, s);
      if (of.candles.length) {
        saveOrderFlowDay(symbol, d, { date: d, secId: s.secId, fetchedAt: new Date().toISOString(), ...of });
        added++;
      }
    } catch (e) {
      log.error?.(`[orderflow history${symbol === 'NIFTY' ? '' : ` ${symbol}`} ${d}] ${e.message}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (added) log.info?.(`[orderflow${symbol === 'NIFTY' ? '' : ` ${symbol}`}] stored ${added} past day(s) for SEC_ID ${s.secId}`);
  return added;
}

/** Stored days (newest first) for the contract, ending at `until` (YYYY-MM-DD, default today) inclusive. */
export function orderFlowDays(symbol, secId, { days = 16, until = istDate() } = {}) {
  const out = [];
  const end = new Date(`${until}T12:00:00+05:30`).getTime();
  for (let back = 0; out.length < days && back < days * 2; back++) {
    const d = istDate(end - back * 86400e3);
    const f = getOrderFlowDay(symbol, d);
    if (f?.secId === secId && f.candles?.length) out.push(f);
  }
  return out;
}

/** All stored dates for the session's contract (oldest first). */
export function storedOrderFlowDates(symbol) {
  const s = loadDhanSession(symbol);
  const dir = path.join(DATA_DIR, symbol, 'orderflow');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .filter((d) => !s || getOrderFlowDay(symbol, d)?.secId === s.secId)
    .sort();
}

/**
 * Makes sure a past trading day is stored for the session's contract, downloading it from Dhan if needed
 * (one request). Today is handled by the live poller. Returns the stored day or null (weekend/holiday/no session).
 */
export async function ensureOrderFlowDay(symbol, date) {
  const s = loadDhanSession(symbol);
  const have = getOrderFlowDay(symbol, date);
  if (!s || (have?.secId === s.secId && have.candles?.length) || date >= istDate()) return have;
  const wd = new Date(`${date}T12:00:00+05:30`).getUTCDay();
  if (wd === 0 || wd === 6) return null;
  const open = Math.floor(new Date(`${date}T09:15:00+05:30`).getTime() / 1000);
  const close = Math.floor(new Date(`${date}T15:30:00+05:30`).getTime() / 1000);
  const of = await fetchOrderFlow(open, close, s);
  if (!of.candles.length) return null;
  const day = { date, secId: s.secId, fetchedAt: new Date().toISOString(), ...of };
  saveOrderFlowDay(symbol, date, day);
  return day;
}

/** Every `seconds` (aligned to the minute + 8 s) during market hours, refresh today's order flow. */
export function startOrderFlowPoller(symbol, { seconds = 60, isMarketOpen, force = false, log = console } = {}) {
  let timer = null;
  const tick = async ({ force: forceNow = false } = {}) => {
    if (!loadDhanSession(symbol) || (!force && !forceNow && !isMarketOpen())) return;
    try {
      await syncOrderFlowToday(symbol);
    } catch (e) {
      log.error?.(`[orderflow ${symbol}] ${e.message}`);
    }
  };
  const schedule = () => {
    const period = seconds * 1000;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, period - (Date.now() % period) + 8_000);
  };
  tick();
  schedule();
  return { tickNow: tick, stop: () => clearTimeout(timer) };
}
