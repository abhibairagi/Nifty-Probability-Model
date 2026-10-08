// Builds the Order Flow tab's zone view: supply/demand zones from the stored order-flow history of the current
// futures contract, plus a live read of any zone tested today. Never used by the probability model.

import { loadDhanSession, orderFlowDays, ensureOrderFlowDay } from '../providers/dhan.js';
import { findFuture } from '../providers/kiteInstruments.js';
import { historical, loadKiteSession } from '../providers/kite.js';
import { to15m, aggressionEvents, buildZones, analyzeTest, statusHistory } from './zones.js';

const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
let closesCache = { key: null, at: 0, map: new Map(), last: null };

/** Kite 15-minute closes for the same futures contract (Dhan candles have no close). Cached for 60 s. */
async function futureCloses(expiry, fromDate, toDate, symbol = 'NIFTY') {
  const fut = expiry ? findFuture(symbol, expiry) : null;
  if (!fut || !loadKiteSession()) return { map: new Map(), last: null };
  const key = `${fut.token}|${fromDate}|${toDate}`;
  // past days never change: cache them for an hour; the current day for a minute
  const ttl = toDate < istDate() ? 3600_000 : 60_000;
  if (closesCache.key === key && Date.now() - closesCache.at < ttl) return closesCache;
  const candles = await historical(fut.token, '15minute', fromDate, toDate);
  const map = new Map(candles.map((c) => [Math.round(c.t / 1000), c.close]));
  closesCache = { key, at: Date.now(), map, last: candles.at(-1)?.close ?? null };
  return closesCache;
}

/**
 * Zones as they stood on `date` (default today): built only from that day and the trading days before it,
 * with that day's zone tests read as they would have been live. Past days are downloaded on demand.
 */
export async function orderFlowZones(symbol = 'NIFTY', { range = 0.03, maxZones = 10, date = istDate() } = {}) {
  const s = loadDhanSession(symbol);
  if (!s) return { configured: false, zones: [] };
  await ensureOrderFlowDay(symbol, date).catch(() => null);
  const days = orderFlowDays(symbol, s.secId, { until: date }); // newest first
  if (!days.length || days[0].date !== date) return { configured: true, date, zones: [], days: days.map((d) => d.date).reverse() };
  const today = date;
  const expiry = days[0].expiry;
  const oldest = days.at(-1).date;

  let closes = { map: new Map(), last: null };
  let closeError = null;
  try {
    closes = await futureCloses(expiry, oldest, date, symbol);
  } catch (e) {
    closeError = e.message;
  }

  const bars = days.flatMap((d) => to15m(d.candles, { closes: closes.map }));
  const todayDay = days.find((d) => d.date === today);
  const todayMinutes = todayDay?.candles ?? [];
  const lastMin = todayMinutes.at(-1) ?? days[0].candles.at(-1);
  // only finished bars create zones
  const done = bars.filter((b) => b.t + 900 <= lastMin.t + 60);
  const events = aggressionEvents(done);
  const price = closes.last ?? (lastMin.high + lastMin.low) / 2;
  const zones = buildZones(events, { nowSec: lastMin.t })
    .filter((z) => Math.abs((z.low + z.high) / 2 - price) <= price * range)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxZones)
    .map((z) => ({
      ...z,
      role: z.low > price ? 'resistance' : z.high < price ? 'support' : 'at zone',
      distance: Math.round(z.low > price ? z.low - price : z.high < price ? price - z.high : 0),
      test: (() => {
        const bars15 = to15m(todayMinutes, { closes: closes.map });
        const t = todayMinutes.length ? analyzeTest(z, todayMinutes, bars15, price) : null;
        if (!t) return t;
        // when the system gave each status during this touch (minute-by-minute replay) and when the current one began
        const history = statusHistory(z, todayMinutes, bars15);
        const current = [...history].reverse().find((h) => h.status === t.status);
        const withTimes = { ...t, history, statusSince: current?.at ?? todayMinutes.at(-1)?.time ?? null };
        // a past day that closed while price was still in the zone has no outcome — say so instead of "testing"
        if (t.status === 'testing' && date < istDate()) return { ...withTimes, status: 'closed in zone', read: `${t.read} — the day ended inside the zone, no outcome` };
        return withTimes;
      })(),
    }))
    .sort((a, b) => b.high - a.high);

  const res = zones.filter((z) => z.role === 'resistance').sort((a, b) => a.low - b.low)[0] ?? null;
  const sup = zones.filter((z) => z.role === 'support').sort((a, b) => b.high - a.high)[0] ?? null;
  return {
    configured: true,
    date,
    contract: { secId: s.secId, instrument: days[0].instrument, expiry },
    price,
    priceSource: closes.last != null ? 'Kite futures (15-min candle)' : 'Dhan last minute (mid of high/low)',
    closeError,
    days: days.map((d) => d.date).reverse(),
    bars: done.length,
    aggressiveBars: events.length,
    zones,
    nearestResistance: res,
    nearestSupport: sup,
    watch: zones.filter((z) => z.test && (z.test.status === 'testing' || Date.now() / 1000 - (todayMinutes.at(-1)?.t ?? 0) < 1800)),
  };
}
