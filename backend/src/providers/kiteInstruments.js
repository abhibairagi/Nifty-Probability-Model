// Kite instrument master: maps NIFTY option strikes / futures to Kite instrument tokens.
//
// The NFO dump (https://api.kite.trade/instruments/NFO, ~3 MB CSV) is downloaded once a day, in the morning,
// on Monday–Thursday only (per the user's rule). Other days reuse the most recent download. Only the NIFTY rows
// are kept, in data/instruments/NFO-<YYYY-MM-DD>.json.
//
// SENSEX options/futures trade on BSE F&O, so they come from the BFO dump (https://api.kite.trade/instruments/BFO),
// downloaded on the same schedule into data/instruments/BFO-<YYYY-MM-DD>.json. The NIFTY (NFO) path is unchanged;
// lookups pick the dump by the underlying's name.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'instruments');
const URL_NFO = 'https://api.kite.trade/instruments/NFO';
const FETCH_DAYS = [1, 2, 3, 4]; // Mon–Thu
const KEEP_NAMES = ['NIFTY'];
const URL_BFO = 'https://api.kite.trade/instruments/BFO';
const BFO_NAMES = ['SENSEX'];

const istNow = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3);
const istDate = (ms = Date.now()) => istNow(ms).toISOString().slice(0, 10);

/** Minimal CSV line parser (fields may be "quoted"). */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseInstrumentsCsv(text, names = KEEP_NAMES) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]);
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = splitCsv(line);
    const name = f[idx.name];
    if (!names.includes(name)) continue;
    const type = f[idx.instrument_type];
    if (!['CE', 'PE', 'FUT'].includes(type)) continue;
    rows.push({
      token: Number(f[idx.instrument_token]),
      tradingsymbol: f[idx.tradingsymbol],
      name,
      expiry: f[idx.expiry],
      strike: Number(f[idx.strike]),
      type,
      lotSize: Number(f[idx.lot_size]),
    });
  }
  return rows;
}

function latestFile() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter((f) => /^NFO-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(DIR, files.at(-1)) : null;
}

let cache = null; // { date, fetchedAt, rows, index }

function index(rows) {
  const opt = new Map(); // `${name}|${expiry}|${strike}|${type}` → row
  const fut = new Map(); // name → futures sorted by expiry
  for (const r of rows) {
    if (r.type === 'FUT') fut.set(r.name, [...(fut.get(r.name) ?? []), r].sort((a, b) => a.expiry.localeCompare(b.expiry)));
    else opt.set(`${r.name}|${r.expiry}|${r.strike}|${r.type}`, r);
  }
  return { opt, fut };
}

function load() {
  const f = latestFile();
  if (!f) return null;
  if (cache?.file === f) return cache;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  cache = { ...data, file: f, index: index(data.rows) };
  return cache;
}

// ---- BFO (SENSEX) — separate files and cache, so the NFO dump above is never affected ----

function latestBfoFile() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter((f) => /^BFO-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(DIR, files.at(-1)) : null;
}

let bfoCache = null;

function loadBfo() {
  const f = latestBfoFile();
  if (!f) return null;
  if (bfoCache?.file === f) return bfoCache;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  bfoCache = { ...data, file: f, index: index(data.rows) };
  return bfoCache;
}

/** The dump an underlying lives in: SENSEX → BFO, everything else (NIFTY) → NFO. */
const loadFor = (name) => (BFO_NAMES.includes(name) ? loadBfo() : load());

/** BFO counterpart of ensureInstruments (same Mon–Thu rule). */
export async function ensureBfoInstruments({ force = false, log = console } = {}) {
  const today = istDate();
  const have = loadBfo();
  if (have?.date === today && !force) return { fetched: false, date: have.date, count: have.rows.length };
  const day = istNow().getUTCDay();
  if (!force && !FETCH_DAYS.includes(day) && have) return { fetched: false, date: have.date, count: have.rows.length };

  const res = await fetch(URL_BFO, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`BFO instruments HTTP ${res.status}`);
  const rows = parseInstrumentsCsv(await res.text(), BFO_NAMES);
  if (!rows.length) throw new Error('BFO instruments dump had no SENSEX rows');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `BFO-${today}.json`), JSON.stringify({ date: today, fetchedAt: new Date().toISOString(), rows }));
  const old = fs.readdirSync(DIR).filter((f) => f.startsWith('BFO-')).sort().slice(0, -5);
  for (const f of old) fs.rmSync(path.join(DIR, f), { force: true });
  bfoCache = null;
  log.info?.(`[instruments] downloaded BFO dump: ${rows.length} SENSEX instruments`);
  return { fetched: true, date: today, count: rows.length };
}

/** Downloads today's dump if it's Mon–Thu and not downloaded yet today. Returns { fetched, date, count }. */
export async function ensureInstruments({ force = false, log = console } = {}) {
  const today = istDate();
  const have = load();
  if (have?.date === today && !force) return { fetched: false, date: have.date, count: have.rows.length };
  const day = istNow().getUTCDay();
  if (!force && !FETCH_DAYS.includes(day) && have) return { fetched: false, date: have.date, count: have.rows.length };

  const res = await fetch(URL_NFO, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`instruments HTTP ${res.status}`);
  const rows = parseInstrumentsCsv(await res.text());
  if (!rows.length) throw new Error('instruments dump had no NIFTY rows');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `NFO-${today}.json`), JSON.stringify({ date: today, fetchedAt: new Date().toISOString(), rows }));
  // keep only the last 5 downloads
  const old = fs.readdirSync(DIR).filter((f) => f.startsWith('NFO-')).sort().slice(0, -5);
  for (const f of old) fs.rmSync(path.join(DIR, f), { force: true });
  cache = null;
  log.info?.(`[instruments] downloaded NFO dump: ${rows.length} NIFTY instruments`);
  return { fetched: true, date: today, count: rows.length };
}

/**
 * Runs ensureInstruments now and every morning at 08:45 IST (it skips Fri–Sun by itself).
 * Returns a promise for the first run, so callers can wait until tokens are available.
 */
export function scheduleInstruments({ log = console, bfo = false } = {}) {
  const run = () =>
    Promise.all([
      ensureInstruments({ log }).catch((e) => log.error?.(`[instruments] ${e.message}`)),
      bfo ? ensureBfoInstruments({ log }).catch((e) => log.error?.(`[instruments BFO] ${e.message}`)) : null,
    ]);
  const first = run();
  const next = () => {
    const now = istNow();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 45));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  };
  const loop = () =>
    setTimeout(() => {
      run();
      loop();
    }, next());
  loop();
  return first;
}

/** Instrument row for an option, or null. expiry is YYYY-MM-DD. */
export function findOption(name, expiry, strike, type) {
  return loadFor(name)?.index.opt.get(`${name}|${expiry}|${strike}|${type}`) ?? null;
}

/** Nearest futures contract on/after the date. */
export function nearestFuture(name, date = istDate()) {
  return loadFor(name)?.index.fut.get(name)?.find((r) => r.expiry >= date) ?? null;
}

/** Option expiry dates (YYYY-MM-DD, ascending) for an underlying, from the stored instruments list. */
export function optionExpiries(name) {
  const rows = loadFor(name)?.rows ?? [];
  return [...new Set(rows.filter((r) => r.name === name && r.type !== 'FUT').map((r) => r.expiry))].sort();
}

/** Futures contract with an exact expiry date (YYYY-MM-DD), or null. */
export function findFuture(name, expiry) {
  return loadFor(name)?.index.fut.get(name)?.find((r) => r.expiry === expiry) ?? null;
}

export function instrumentsStatus() {
  const c = load();
  return c ? { date: c.date, fetchedAt: c.fetchedAt, count: c.rows.length } : null;
}

export function bfoInstrumentsStatus() {
  const c = loadBfo();
  return c ? { date: c.date, fetchedAt: c.fetchedAt, count: c.rows.length } : null;
}
