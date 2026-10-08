// JSON-file storage, one folder per instrument:
//   data/<SYMBOL>/snapshots/<YYYY-MM-DD>.json  → array of normalized snapshots for that IST trading day
//   data/<SYMBOL>/reports/<YYYY-MM-DD>.json    → compact report summaries (bias timeline, for backtesting)
//   data/<SYMBOL>/config.json                  → model config (zones, weights, target probability)
// A "date" is just a bucket name, so non-date buckets like "sim" work too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const dirs = (symbol) => {
  const root = path.join(DATA_DIR, symbol);
  return {
    root,
    snaps: path.join(root, 'snapshots'),
    reports: path.join(root, 'reports'),
    live: path.join(root, 'live'),
    config: path.join(root, 'config.json'),
  };
};

function ensureDirs(symbol) {
  const d = dirs(symbol);
  fs.mkdirSync(d.snaps, { recursive: true });
  fs.mkdirSync(d.reports, { recursive: true });
  return d;
}

/** IST calendar date (YYYY-MM-DD) for a timestamp. */
export function istDate(ts = Date.now()) {
  return new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] could not read ${file}: ${e.message}`);
    return fallback;
  }
}

// Write to a temp file then rename, so a crash mid-write never corrupts the day's data
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const cache = new Map(); // "SYMBOL:date" → snapshots[]

export function getSnapshots(symbol, date = istDate()) {
  const key = `${symbol}:${date}`;
  if (!cache.has(key)) cache.set(key, readJson(path.join(dirs(symbol).snaps, `${date}.json`), []));
  return cache.get(key);
}

/** Appends a snapshot (replaces one with the same timestamp). */
export function appendSnapshot(symbol, snap, date = istDate(snap.timestamp)) {
  const d = ensureDirs(symbol);
  const list = getSnapshots(symbol, date);
  const i = list.findIndex((s) => s.timestamp === snap.timestamp);
  if (i >= 0) list[i] = snap;
  else list.push(snap);
  list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeJson(path.join(d.snaps, `${date}.json`), list);
  return list;
}

/** Inserts/replaces many snapshots (matched by timestamp) with a single write. */
export function mergeSnapshots(symbol, date, snaps) {
  const d = ensureDirs(symbol);
  const list = getSnapshots(symbol, date);
  const byTs = new Map(list.map((s, i) => [s.timestamp, i]));
  for (const snap of snaps) {
    const i = byTs.get(snap.timestamp);
    if (i != null) list[i] = snap;
    else list.push(snap);
  }
  list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeJson(path.join(d.snaps, `${date}.json`), list);
  return list;
}

/** Removes a bucket's snapshots and reports (used by the simulator to start fresh). */
export function clearBucket(symbol, date) {
  cache.delete(`${symbol}:${date}`);
  const d = dirs(symbol);
  for (const dir of [d.snaps, d.reports]) fs.rmSync(path.join(dir, `${date}.json`), { force: true });
}

export function listDates(symbol) {
  const { snaps } = dirs(symbol);
  if (!fs.existsSync(snaps)) return [];
  return fs
    .readdirSync(snaps)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();
}

export function getReports(symbol, date = istDate()) {
  return readJson(path.join(dirs(symbol).reports, `${date}.json`), []);
}

export function summarize(report) {
  return {
    timestamp: report.timestamp,
    spot: report.market.spot,
    atmIv: report.market.atmIv,
    vix: report.market.vix,
    dayScore: report.dayBias.score,
    dayLabel: report.dayBias.label,
    dayProbabilities: report.dayBias.probabilities,
    score: report.bias.score,
    label: report.bias.label,
    probabilities: report.bias.probabilities,
    range: report.bias.range.score,
    confidence: report.bias.confidence,
    support: report.levels.support,
    resistance: report.levels.resistance,
    suggestedCe: report.suggestions.ce?.strike ?? null,
    suggestedPe: report.suggestions.pe?.strike ?? null,
    alerts: report.alerts.length,
  };
}

export function appendReportSummary(symbol, report, date = istDate(report.timestamp)) {
  const list = getReports(symbol, date).filter((r) => r.timestamp !== report.timestamp);
  list.push(summarize(report));
  return saveReports(symbol, date, list);
}

export function saveReports(symbol, date, list) {
  const d = ensureDirs(symbol);
  list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeJson(path.join(d.reports, `${date}.json`), list);
  return list;
}

// ---- 1-minute price series (spot, forward, VIX, future, every strike's premium + IV) -------------------------
// Compact rows: { t, expiry, spot, forward, futures, futuresOi, vix, s: [[strike, ceLtp, ceIv, peLtp, peIv], …] }

const liveCache = new Map(); // "SYMBOL:date" → rows[]

export function getLive(symbol, date = istDate()) {
  const key = `${symbol}:${date}`;
  if (!liveCache.has(key)) liveCache.set(key, readJson(path.join(dirs(symbol).live, `${date}.json`), []));
  return liveCache.get(key);
}

export function appendLive(symbol, row, date = istDate(row.t)) {
  const d = dirs(symbol);
  fs.mkdirSync(d.live, { recursive: true });
  const list = getLive(symbol, date).filter((r) => r.t !== row.t);
  list.push(row);
  list.sort((a, b) => a.t.localeCompare(b.t));
  liveCache.set(`${symbol}:${date}`, list);
  writeJson(path.join(d.live, `${date}.json`), list);
  return list;
}

export function getConfig(symbol) {
  return readJson(dirs(symbol).config, {});
}

export function saveConfig(symbol, cfg) {
  writeJson(ensureDirs(symbol).config, cfg);
  return cfg;
}
