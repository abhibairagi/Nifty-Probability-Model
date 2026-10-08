// Sensibull provider — uses the daily pasted session (see sensibullSession.js).
//
// Each poll makes two calls:
//   oi_chart         → total OI per strike (ATM ± 10 strikes) + spot, PCR, previous-day OI   → the snapshot
//   oi_change_chart  → OI change per strike over the last 5 minutes                          → attached as oiChange5m
//
// Backfill: with auto_update "disabled", oi_chart returns OI as of `to_time` (and date_ltp = spot then), so a session
// started mid-day can be rebuilt from 09:15 at 3-minute steps (live polling runs every POLL_MINUTES).
//
// These endpoints carry no per-strike premium or IV. The engine then reads OI↑ as writing and OI↓ as covering
// (Sensibull's own convention) and uses the ATM IV from config (Sessions page) for probabilities.

import { loadSession, recordResult, STD_HEADERS } from './sensibullSession.js';
import { optionExpiries } from './kiteInstruments.js';
import { istDate } from '../store.js';
import { getInstrument, nextExpiry } from '../instruments.js';

const BASE = 'https://oxide.sensibull.com/v1/compute/1/oi_graphs';
const MARKET_OPEN_UTC = '03:45:00Z'; // 09:15 IST

/**
 * Enables only the nearest expiry on/after today (from the Kite instruments list; the instrument's next weekly
 * expiry as a fallback). The month's last expiry is the monthly one (is_weekly: false).
 */
export function pickExpiries(symbol, dates = [], today = istDate()) {
  const list = [...new Set(dates)].sort();
  const nearest = list.find((d) => d >= today) ?? istDate(new Date(nextExpiry(symbol)).getTime());
  const monthly = (d) => !list.some((x) => x > d && x.slice(0, 7) === d.slice(0, 7)) && list.includes(d);
  return { expiries: { [nearest]: { is_weekly: !monthly(nearest), is_enabled: true } }, expiry: nearest };
}

const isoMinute = (ms) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace('.000Z', 'Z');

/** Maps the two responses to the normalized snapshot format. */
export function normalizeSensibull(chart, change, { symbol, expiryDate }) {
  const p = chart?.payload;
  if (!chart?.success || !p?.per_strike_data) throw new Error(`unexpected oi_chart response: ${JSON.stringify(chart).slice(0, 200)}`);
  const ch = change?.payload?.per_strike_data ?? {};
  const { expiryTime } = getInstrument(symbol);
  const enabled = Object.entries(p.input?.expiries ?? {}).find(([, v]) => v.is_enabled)?.[0] ?? expiryDate;
  const historical = p.input?.auto_update === 'disabled'; // backfill request: OI and date_ltp are as of to_time

  return {
    timestamp: historical ? p.input.to_time : p.intraday_last_available_timestamp ?? new Date().toISOString(),
    symbol,
    expiry: `${enabled}T${expiryTime}:00+05:30`,
    spot: historical ? p.date_ltp : p.current_ltp,
    prevClose: p.prev_ltp,
    strikes: Object.entries(p.per_strike_data).map(([strike, d]) => ({
      strike: Number(strike),
      ce: { oi: d.call_oi, prevOi: d.prev_call_oi ?? null, oiChange5m: ch[strike]?.call_oi_change ?? null },
      pe: { oi: d.put_oi, prevOi: d.prev_put_oi ?? null, oiChange5m: ch[strike]?.put_oi_change ?? null },
    })),
  };
}

export function createSensibullProvider(symbol = 'NIFTY', { strikeSelection = process.env.SENSIBULL_STRIKES || 'ten' } = {}) {
  async function post(endpoint, session, body) {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { ...STD_HEADERS, cookie: session.cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Sensibull ${res.status}: session expired — paste a fresh curl on the Sessions page`);
    if (!res.ok) throw new Error(`Sensibull ${endpoint} HTTP ${res.status}`);
    return res.json();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    name: 'sensibull',
    symbol,

    /** OI snapshots from `fromMs` to `toMs` every `stepMin` minutes (sequential and throttled to be gentle on Sensibull). */
    async backfill(fromMs, toMs, { stepMin = 3, gapMs = 400 } = {}) {
      const session = loadSession();
      if (!session) throw new Error('no Sensibull session');
      const today = istDate(toMs);
      const { expiries, expiry } = pickExpiries(symbol, optionExpiries(symbol), today);
      const out = [];
      for (let t = fromMs; t <= toMs; t += stepMin * 60_000) {
        const chart = await post('oi_chart', session, {
          underlying: symbol, expiries, atm_strike_selection: strikeSelection, input_min_strike: null, input_max_strike: null,
          from_time: `${today}T${MARKET_OPEN_UTC}`, to_time: isoMinute(t), auto_update: 'disabled', show_prev_oi: true,
        });
        const snap = normalizeSensibull(chart, null, { symbol, expiryDate: expiry });
        out.push(snap);
        await sleep(gapMs);
      }
      return out;
    },

    async fetchSnapshot() {
      const session = loadSession();
      if (!session) throw new Error('no Sensibull session — paste a curl on the Sessions page');
      try {
        const now = Date.now();
        const today = istDate(now);
        // before 09:16 IST there is no OI for today yet — wait instead of erroring
        if (new Date(now + 5.5 * 3600e3).toISOString().slice(11, 16) < '09:16') {
          throw Object.assign(new Error('market opens at 09:15 — first OI reading after 09:16'), { waiting: true });
        }
        const { expiries, expiry } = pickExpiries(symbol, optionExpiries(symbol), today);
        const common = { underlying: symbol, expiries, atm_strike_selection: strikeSelection, input_min_strike: null, input_max_strike: null };

        // live requests carry no date / time window: Sensibull fills in today (sending `date` returns
        // "invalid input date" on some days)
        const [chart, change] = await Promise.all([
          post('oi_chart', session, { ...common, auto_update: 'full_day', show_prev_oi: true }),
          post('oi_change_chart', session, { ...common, mode: 'intraday', auto_update: 'last_five_min', from_date: null, to_date: null, show_oi: false }).catch(() => null), // optional
        ]);
        const snap = normalizeSensibull(chart, change, { symbol, expiryDate: expiry });
        recordResult({ ok: true, symbol, spot: snap.spot, strikes: snap.strikes.length, dataTime: snap.timestamp });
        return snap;
      } catch (e) {
        recordResult(e.waiting ? { ok: true, waiting: true, symbol, note: e.message } : { ok: false, symbol, error: e.message });
        throw e;
      }
    },
  };
}
