// Ingest → store → analyze pipeline, plus the OI poller (every POLL_MINUTES).

import { normalizeSnapshot } from './engine/snapshot.js';
import { analyze } from './engine/index.js';
import * as store from './store.js';
import { getInstrument } from './instruments.js';
import { latestIntraday } from './providers/sensibullIntraday.js';

const latest = new Map(); // "SYMBOL:date" → last full report

/** Newest 1-minute prices for a day, expanded from the stored compact row. */
function latestLive(symbol, date) {
  const row = store.getLive(symbol, date).at(-1);
  if (!row) return null;
  return {
    timestamp: row.t,
    expiry: row.expiry,
    spot: row.spot,
    forward: row.forward,
    futures: row.futures,
    vix: row.vix,
    strikes: row.s.map(([strike, ceLtp, ceIv, peLtp, peIv]) => ({ strike, ce: { ltp: ceLtp, iv: ceIv }, pe: { ltp: peLtp, iv: peIv } })),
  };
}

export function isMarketDay(nowMs = Date.now()) {
  const day = new Date(nowMs + 5.5 * 3600e3).getUTCDay();
  return day >= 1 && day <= 5;
}

export function isMarketOpen(nowMs = Date.now()) {
  const ist = new Date(nowMs + 5.5 * 3600e3);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Snapshots for analysis: same day, same expiry as the newest one. */
function sessionSnapshots(symbol, date) {
  const all = store.getSnapshots(symbol, date);
  if (!all.length) return [];
  const expiry = all.at(-1).expiry;
  return all.filter((s) => s.expiry === expiry);
}

export function analyzeDate(symbol, date = store.istDate(), { persist = false } = {}) {
  const snaps = sessionSnapshots(symbol, date);
  if (!snaps.length) return null;
  const key = `${symbol}:${date}`;
  const report = analyze(snaps, store.getConfig(symbol), latest.get(key) ?? null, latestLive(symbol, date), latestIntraday(symbol, date));
  latest.set(key, report);
  if (persist) store.appendReportSummary(symbol, report, date);
  return report;
}

export function getReport(symbol, date = store.istDate()) {
  return latest.get(`${symbol}:${date}`) ?? analyzeDate(symbol, date);
}

/** Replays the model over every prefix of the session so the timeline reflects what was knowable at each time. */
export function rebuildTimeline(symbol, date) {
  const snaps = sessionSnapshots(symbol, date);
  const cfg = store.getConfig(symbol);
  const list = [];
  let prev = null;
  for (let i = 1; i <= snaps.length; i++) {
    prev = analyze(snaps.slice(0, i), cfg, prev);
    list.push(store.summarize(prev));
  }
  store.saveReports(symbol, date, list);
  if (prev) latest.set(`${symbol}:${date}`, prev);
  return prev;
}

/**
 * If today's session is missing its start (e.g. the curl was pasted mid-day or the backend started late),
 * rebuild it from 09:15 IST using the provider's backfill, then recompute the timeline.
 */
export async function backfillToday(provider, { log = console, enrich = async (r) => r } = {}) {
  if (!provider.backfill) return 0;
  const now = Date.now();
  const date = store.istDate(now);
  const open = new Date(`${date}T09:15:00+05:30`).getTime();
  const close = new Date(`${date}T15:30:00+05:30`).getTime();
  if (now < open + 60_000 || !isMarketDay(now)) return 0;
  const have = store.getSnapshots(provider.symbol, date);
  const firstTs = have.length ? new Date(have[0].timestamp).getTime() : Infinity;
  if (firstTs <= open + 5 * 60_000) return 0; // already starts at the open
  const until = Math.min(now - 60_000, close, firstTs - 60_000);
  log.info?.(`[backfill ${provider.symbol}] rebuilding ${date} from 09:15 …`);
  const raws = await provider.backfill(open, until);
  const snaps = [];
  for (const raw of raws) snaps.push(normalizeSnapshot(await enrich(raw)));
  store.mergeSnapshots(provider.symbol, date, snaps);
  const n = snaps.length;
  rebuildTimeline(provider.symbol, date);
  log.info?.(`[backfill ${provider.symbol}] added ${n} snapshots`);
  return n;
}

/** Fills what an enricher can add (India VIX, premiums/IV, futures) into a stored day's snapshots, then rebuilds its timeline. */
export async function enrichStoredDay(symbol, date, enrich) {
  const snaps = store.getSnapshots(symbol, date);
  const incomplete = (s) =>
    !(s.vix > 0) || s.spotSource !== 'kite' || s.forward == null || s.strikes.some((k) => k.ce.ltp == null || k.pe.ltp == null);
  const missing = snaps.filter(incomplete);
  if (!missing.length) return 0;
  const updated = [];
  for (const s of missing) {
    const e = normalizeSnapshot(await enrich(structuredClone(s)));
    if (JSON.stringify(e) !== JSON.stringify(normalizeSnapshot(s))) updated.push(e);
  }
  if (!updated.length) return 0;
  store.mergeSnapshots(symbol, date, updated);
  rebuildTimeline(symbol, date);
  return updated.length;
}

/** Re-runs every cached session of a symbol (after a config change). */
export function reanalyze(symbol) {
  for (const key of [...latest.keys()]) {
    const [sym, date] = key.split(':');
    if (sym === symbol) analyzeDate(symbol, date);
  }
}

/**
 * Accepts a raw (provider-normalized) snapshot, stores it under its symbol, re-runs the model.
 * `bucket` defaults to the IST date.
 */
export function ingest(raw, bucket) {
  const snap = normalizeSnapshot(raw);
  const symbol = getInstrument(snap.symbol).symbol;
  const key = bucket ?? store.istDate(snap.timestamp);
  store.appendSnapshot(symbol, snap, key);
  return analyzeDate(symbol, key, { persist: true });
}

/**
 * Every `seconds` (default 60) during market hours: re-prices the strikes of the latest OI reading with fresh
 * 1-minute data via `enrich` (NIFTY spot, VIX, future, every strike's premium + IV), stores the row in
 * data/<SYMBOL>/live/<date>.json and refreshes the report. OI itself still comes from the OI poller.
 */
export function startPriceTicker(symbol, enrich, { seconds = 60, force = false, log = console } = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running || (!force && !isMarketOpen())) return;
    running = true;
    try {
      const date = store.istDate();
      const base = store.getSnapshots(symbol, date).at(-1);
      if (!base) return;
      const now = Date.now();
      const raw = structuredClone(base);
      Object.assign(raw, { timestamp: new Date(now).toISOString(), spotSource: null, forward: null, futures: null, futuresOi: null, vix: null });
      for (const s of raw.strikes) for (const leg of [s.ce, s.pe]) Object.assign(leg, { ltp: null, iv: null });
      const px = normalizeSnapshot(await enrich(raw));
      if (px.spotSource !== 'kite') return; // no Kite data this minute (no session / error) — keep the last prices
      store.appendLive(
        symbol,
        {
          t: px.timestamp,
          expiry: px.expiry,
          spot: px.spot,
          forward: px.forward,
          futures: px.futures,
          futuresOi: px.futuresOi,
          vix: px.vix,
          s: px.strikes.map((k) => [k.strike, k.ce.ltp, k.ce.iv, k.pe.ltp, k.pe.iv]),
        },
        date,
      );
      analyzeDate(symbol, date);
    } catch (e) {
      log.error?.(`[prices ${symbol}] ${e.message}`);
    } finally {
      running = false;
    }
  }

  // aligned to the minute (+5 s so the minute's candles exist)
  function schedule() {
    const period = seconds * 1000;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, period - (Date.now() % period) + 5_000);
  }
  schedule();
  return { tickNow: tick, stop: () => clearTimeout(timer) };
}

/**
 * Polls `provider` every `minutes` (aligned to the clock) during market hours.
 * `enrich(raw)` can add data from other sources (e.g. India VIX from Kite) before a snapshot is stored.
 */
export function startPoller(provider, { minutes = 3, force = false, log = console, enrich = async (r) => r } = {}) {
  let timer = null;
  let running = false;
  let backfilledFor = null; // IST date already backfilled

  async function run({ force: forceNow = false } = {}) {
    if (running) return;
    if (!force && !forceNow && !isMarketOpen()) return;
    running = true;
    try {
      const today = store.istDate();
      if (backfilledFor !== today) {
        try {
          await backfillToday(provider, { log, enrich });
          backfilledFor = today;
        } catch (e) {
          log.error?.(`[backfill ${provider.symbol}] ${e.message}`);
        }
      }
      const raw = await enrich(await provider.fetchSnapshot());
      const report = ingest(raw);
      log.info?.(`[poll ${provider.name}] ${report.symbol} ${report.timestamp} spot=${report.market.spot} bias=${report.bias.label} (${report.bias.score}) alerts=${report.alerts.length}`);
    } catch (e) {
      if (e.waiting) log.info?.(`[poll ${provider.name}] ${e.message}`);
      else log.error?.(`[poll ${provider.name}] ${e.message}`);
    } finally {
      running = false;
    }
  }

  // Align to clock boundaries (09:15, 09:18, …) + 5 s so the source has updated
  function schedule() {
    const period = minutes * 60_000;
    const wait = period - (Date.now() % period) + 5_000;
    timer = setTimeout(async () => {
      await run();
      schedule();
    }, wait);
  }

  run();
  schedule();
  return {
    runNow: run,
    /** after a new session is pasted: allow the backfill to run again */
    resetBackfill: () => (backfilledFor = null),
    stop: () => clearTimeout(timer),
  };
}

/**
 * Per-strike OI through the day for the OI Analysis → Multi-strike OI view: one column per reading, plus the
 * strikes to start with — fresh put/call OI today (OI now − yesterday's closing OI) and today's biggest walls.
 */
export function oiSeries(symbol, date = store.istDate(), { top = 4, minCoverage = 0.6 } = {}) {
  // market hours only (Sensibull stamps its after-close data 19:30)
  const hhmm = (s) => new Date(new Date(s.timestamp).getTime() + 5.5 * 3600e3).toISOString().slice(11, 16);
  const snaps = sessionSnapshots(symbol, date).filter((s) => hhmm(s) >= '09:15' && hhmm(s) <= '15:30');
  if (!snaps.length) return null;
  const strikes = [...new Set(snaps.flatMap((s) => s.strikes.map((k) => k.strike)))].sort((a, b) => a - b);
  const rows = strikes.map((strike) => {
    const at = snaps.map((s) => s.strikes.find((k) => k.strike === strike));
    const lastLeg = (side) => at.findLast((k) => k?.[side]?.oi != null)?.[side];
    const firstLeg = (side) => at.find((k) => k?.[side]?.oi != null)?.[side];
    const leg = (side) => {
      const last = lastLeg(side);
      const first = firstLeg(side);
      const prev = last?.prevOi ?? first?.prevOi ?? null;
      return {
        oi: at.map((k) => k?.[side]?.oi ?? null),
        now: last?.oi ?? null,
        open: first?.oi ?? null,
        prevClose: prev,
        fresh: last?.oi != null && prev != null ? last.oi - prev : last?.oi != null && first?.oi != null ? last.oi - first.oi : null,
        coverage: at.filter((k) => k?.[side]?.oi != null).length / snaps.length,
      };
    };
    return { strike, ce: leg('ce'), pe: leg('pe') };
  });
  // Sensibull returns ATM ± 10 strikes, so a far strike has OI only while spot was near it — presets skip strikes
  // seen in less than `minCoverage` of the day's readings (they stay selectable in the table)
  const pick = (side, key) =>
    rows
      .filter((r) => r[side][key] != null && r[side].coverage >= minCoverage)
      .sort((a, b) => b[side][key] - a[side][key])
      .slice(0, top)
      .map((r) => ({ strike: r.strike, side, value: r[side][key] }));
  return {
    symbol,
    date,
    expiry: snaps.at(-1).expiry,
    times: snaps.map((s) => s.timestamp),
    spot: snaps.map((s) => s.spot),
    strikes: rows,
    presets: {
      freshPut: pick('pe', 'fresh'),
      freshCall: pick('ce', 'fresh'),
      putWalls: pick('pe', 'now'),
      callWalls: pick('ce', 'now'),
    },
  };
}
