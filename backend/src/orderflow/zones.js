// Order-flow supply/demand zones on 15-minute bars, and live classification of zone tests.
// Order Flow tab only — nothing here feeds the probability model.
//
// 1. 1-minute footprint candles → 15-minute bars (high/low, buy/sell/delta, per-price buckets; close from Kite).
// 2. "Aggressive" bars: |delta| in the top share of all history bars AND |delta| / volume ≥ minImbalance.
//    • aggressive selling → supply level where selling concentrated (most negative bucket delta)
//    • aggressive buying  → demand level where buying concentrated (most positive bucket delta)
//    • absorption: strong buying but the bar closes in its lower third → passive sellers at the bar high (supply);
//      mirrored for strong selling that closes in the upper third (demand)
// 3. Levels within mergePts are merged into zones; strength = Σ aggression × recency decay.
// 4. A test of a zone (price trading into it) is read from the order flow during the test and the 15-min closes.

const BAR_SEC = 15 * 60;

/** Groups 1-minute candles (Dhan) into 15-minute bars. `closes` maps bar start (unix s) → close price (Kite). */
export function to15m(candles, { bucket = 5, closes = new Map() } = {}) {
  const bars = new Map();
  for (const c of candles) {
    const t = Math.floor(c.t / BAR_SEC) * BAR_SEC;
    let b = bars.get(t);
    if (!b) {
      b = { t, day: c.time.slice(0, 10), high: -Infinity, low: Infinity, buy: 0, sell: 0, levels: new Map() };
      bars.set(t, b);
    }
    b.high = Math.max(b.high, c.high);
    b.low = Math.min(b.low, c.low);
    b.buy += c.buy_volume ?? 0;
    b.sell += c.sell_volume ?? 0;
    for (const l of c.levels ?? []) {
      const k = Math.floor(l.price / bucket) * bucket;
      const e = b.levels.get(k) ?? { buy: 0, sell: 0 };
      e.buy += l.buy_volume ?? 0;
      e.sell += l.sell_volume ?? 0;
      b.levels.set(k, e);
    }
  }
  return [...bars.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({ ...b, delta: b.buy - b.sell, total: b.buy + b.sell, close: closes.get(b.t) ?? null }));
}

const quantile = (arr, q) => {
  if (!arr.length) return Infinity;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Aggression events (candidate levels) from 15-minute bars. */
export function aggressionEvents(bars, { topShare = 0.15, minImbalance = 0.2, bucket = 5 } = {}) {
  const threshold = quantile(bars.map((b) => Math.abs(b.delta)), 1 - topShare);
  const events = [];
  for (const b of bars) {
    if (!b.total || Math.abs(b.delta) < threshold || Math.abs(b.delta) / b.total < minImbalance) continue;
    const lv = [...b.levels.entries()].map(([price, e]) => ({ price, d: e.buy - e.sell }));
    if (!lv.length) continue;
    const range = b.high - b.low || 1;
    const pos = b.close != null ? (b.close - b.low) / range : null; // 0 = closed at low, 1 = at high
    const base = { t: b.t, day: b.day, weight: Math.abs(b.delta), barHigh: b.high, barLow: b.low, close: b.close };

    if (b.delta < 0) {
      const top = lv.reduce((a, x) => (x.d < a.d ? x : a));
      if (pos != null && pos > 2 / 3) {
        // heavy selling but closed near the high → passive buyers absorbed it at the bar low
        events.push({ ...base, side: 'demand', kind: 'absorption', price: Math.floor(b.low / bucket) * bucket });
      } else events.push({ ...base, side: 'supply', kind: 'aggressive selling', price: top.price });
    } else {
      const top = lv.reduce((a, x) => (x.d > a.d ? x : a));
      if (pos != null && pos < 1 / 3) {
        // heavy buying but closed near the low → passive sellers absorbed it at the bar high
        events.push({ ...base, side: 'supply', kind: 'absorption', price: Math.floor(b.high / bucket) * bucket });
      } else events.push({ ...base, side: 'demand', kind: 'aggressive buying', price: top.price });
    }
  }
  return events;
}

/** Merges events into zones. `nowSec` sets recency decay (half-life in trading days ≈ calendar days here). */
export function buildZones(events, { mergePts = 15, maxWidth = 30, minWidth = 10, bucket = 5, halfLifeDays = 5, nowSec = Date.now() / 1000 } = {}) {
  const sorted = [...events].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const e of sorted) {
    const c = clusters.at(-1);
    // merge nearby levels, but never let one zone grow wider than maxWidth (no chaining across a whole range)
    if (c && e.price - c.hi <= mergePts && e.price - c.lo <= maxWidth) {
      c.items.push(e);
      c.hi = e.price;
    } else clusters.push({ lo: e.price, hi: e.price, items: [e] });
  }
  return clusters.map((c) => {
    let supply = 0;
    let demand = 0;
    for (const e of c.items) {
      const w = e.weight * 0.5 ** ((nowSec - e.t) / 86400 / halfLifeDays);
      if (e.side === 'supply') supply += w;
      else demand += w;
    }
    let low = c.lo;
    let high = c.hi + bucket;
    if (high - low < minWidth) {
      const mid = (low + high) / 2;
      low = mid - minWidth / 2;
      high = mid + minWidth / 2;
    }
    const last = c.items.reduce((a, e) => (e.t > a.t ? e : a));
    return {
      low,
      high,
      origin: supply >= demand ? 'supply' : 'demand',
      strength: Math.round(supply + demand),
      supply: Math.round(supply),
      demand: Math.round(demand),
      events: c.items.length,
      days: [...new Set(c.items.map((e) => e.day))].sort(),
      lastEvent: { day: last.day, t: last.t, kind: last.kind },
    };
  });
}

/**
 * Reads the latest test of a zone from today's 1-minute candles and 15-minute bars.
 * `price` is the latest traded futures price. Returns null when the zone hasn't been touched today.
 */
// buffer: zone padding for touches, breakouts and rejections; breakdownBuffer: how far below support a 15-min close
// must be (more than) to confirm a breakdown.
export function analyzeTest(zone, minutes, bars15, price, { buffer = 5, breakdownBuffer = 15 } = {}) {
  const lo = zone.low - buffer;
  const hi = zone.high + buffer;
  // most recent touch episode: minutes trading into the (buffered) zone, allowing short gaps (≤ 5 min)
  let end = -1;
  for (let i = minutes.length - 1; i >= 0; i--) {
    if (minutes[i].high >= lo && minutes[i].low <= hi) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  for (let i = end - 1, gap = 0; i >= 0; i--) {
    if (minutes[i].high >= lo && minutes[i].low <= hi) {
      start = i;
      gap = 0;
    } else if (++gap > 5) break;
  }
  // the test = minutes in the zone plus the reaction: up to 15 minutes after the last touch
  const ep = minutes.slice(start, Math.min(minutes.length, end + 16));
  const delta = ep.reduce((a, c) => a + (c.delta ?? 0), 0);
  const buy = ep.reduce((a, c) => a + (c.buy_volume ?? 0), 0);
  const sell = ep.reduce((a, c) => a + (c.sell_volume ?? 0), 0);
  const imbalance = buy + sell ? delta / (buy + sell) : 0;
  const t0 = minutes[start].t;
  const closes = bars15.filter((b) => b.t + BAR_SEC > t0 && b.close != null && b.t + BAR_SEC <= (minutes.at(-1).t + 60));
  const closedAbove = closes.some((b) => b.close > zone.high);
  const closedBelow = closes.some((b) => b.close < zone.low);
  const lastClose = closes.at(-1)?.close ?? null;

  // approached from below → testing it as resistance; from above → as support
  const before = minutes[Math.max(0, start - 1)];
  const role = (before.high + before.low) / 2 < (zone.low + zone.high) / 2 ? 'resistance' : 'support';
  const buyersLead = imbalance > 0.05;
  const sellersLead = imbalance < -0.05;
  let status;
  let read;

  if (role === 'resistance') {
    if (closedAbove && price <= zone.high) {
      status = 'failed breakout';
      read = 'Closed above, then fell back into/below the zone — failed breakout (bearish)';
    } else if (lastClose != null && lastClose > zone.high + buffer) {
      status = buyersLead ? 'breakout' : 'weak breakout';
      read = buyersLead ? 'Closed above resistance with buyers aggressive — breakout' : 'Closed above resistance without strong buying — breakout may fail';
    } else if (price < zone.low - buffer) {
      status = buyersLead ? 'absorbed' : 'rejected';
      read = buyersLead
        ? 'Buyers were aggressive at the zone but price fell back — passive sellers absorbed them (reversal)'
        : 'Sellers defended the zone — rejection (reversal)';
    } else {
      status = 'testing';
      read = buyersLead ? 'Price at resistance, buyers pushing — breakout attempt' : sellersLead ? 'Price at resistance, sellers defending' : 'Price at resistance, flow balanced';
    }
  } else if (closedBelow && price >= zone.low) {
    status = 'failed breakdown';
    read = 'Closed below, then recovered into/above the zone — failed breakdown (bullish)';
  } else if (lastClose != null && lastClose < zone.low - breakdownBuffer) {
    status = sellersLead ? 'breakdown' : 'weak breakdown';
    read = sellersLead ? 'Closed below support with sellers aggressive — breakdown' : 'Closed below support without strong selling — breakdown may fail';
  } else if (lastClose != null && lastClose < zone.low) {
    status = 'testing';
    read = `15-min close ${Math.round(zone.low - lastClose)} pts below support — breakdown not confirmed until a close more than ${breakdownBuffer} pts below${sellersLead ? ' (sellers pushing)' : ''}`;
  } else if (price > zone.high + buffer) {
    status = sellersLead ? 'absorbed' : 'held';
    read = sellersLead
      ? 'Sellers were aggressive at the zone but price recovered — passive buyers absorbed them (reversal)'
      : 'Buyers defended the zone — support held (reversal)';
  } else {
    status = 'testing';
    read = sellersLead ? 'Price at support, sellers pushing — breakdown attempt' : buyersLead ? 'Price at support, buyers defending' : 'Price at support, flow balanced';
  }

  return {
    role,
    status,
    read,
    since: minutes[start].time,
    lastTouch: minutes[end].time,
    minutes: ep.length,
    delta,
    buy,
    sell,
    imbalance: Math.round(imbalance * 100),
    lastClose,
  };
}

/**
 * When the system gave each status for the zone's latest test: replays the day minute by minute from the start of
 * that touch (using only data available at each minute, price = that minute's mid) and records every status change.
 * Returns [{ status, at: "YYYY-MM-DD HH:MM:SS" }, …] oldest first, or [] when the zone was not touched.
 */
export function statusHistory(zone, minutes, bars15, opts = {}) {
  const mid = (c) => (c.high + c.low) / 2;
  const latest = minutes.length ? analyzeTest(zone, minutes, bars15, mid(minutes.at(-1)), opts) : null;
  if (!latest) return [];
  const startIdx = minutes.findIndex((c) => c.time === latest.since);
  const out = [];
  for (let k = Math.max(0, startIdx); k < minutes.length; k++) {
    const sub = minutes.slice(0, k + 1);
    const r = analyzeTest(zone, sub, bars15, mid(sub[k]), opts);
    if (r && r.since === latest.since && r.status !== out.at(-1)?.status) out.push({ status: r.status, at: sub[k].time });
  }
  return out;
}
