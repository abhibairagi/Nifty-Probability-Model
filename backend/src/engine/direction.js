// Directional bias + range (sideways vs trending) scoring.
// Every component returns a value in [-1, +1] (positive = bullish) plus a human-readable reason.

import { analyzeInterval, pcr, sellerLevels, ACTIONS } from './oiAnalyzer.js';
import { atmIv } from './snapshot.js';
import { clamp, expectedMove, yearsToExpiry, round } from './math.js';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// How each OI action at a strike reads for direction (CE writing = resistance = bearish, etc.)
const FLOW_SIGN = {
  ce: { [ACTIONS.WRITING]: -1, [ACTIONS.SHORT_COVERING]: 1, [ACTIONS.LONG_BUILDUP]: 0.5, [ACTIONS.LONG_UNWINDING]: -0.3 },
  pe: { [ACTIONS.WRITING]: 1, [ACTIONS.SHORT_COVERING]: -1, [ACTIONS.LONG_BUILDUP]: -0.5, [ACTIONS.LONG_UNWINDING]: 0.3 },
};

/** Proximity-weighted OI flow in [-1, 1]. Strikes near spot count most (Gaussian, width ≈ expected move). */
export function flowScore(rows, spot, width) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const w = Math.exp(-0.5 * ((r.strike - spot) / width) ** 2);
    for (const side of ['ce', 'pe']) {
      const leg = r[side];
      const sign = FLOW_SIGN[side][leg.action];
      if (sign === undefined) continue;
      num += w * sign * Math.abs(leg.dOi);
      den += w * Math.abs(leg.dOi);
    }
  }
  return den ? num / den : 0;
}

const time = (snap) =>
  new Date(snap.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

const tms = (snap) => new Date(snap.timestamp).getTime();

/**
 * The reading `minutes` before the latest one (the newest reading at or before that time; the first reading if the
 * session is younger). Windows are in clock time, so they mean the same at any polling rate or when the feed skips.
 */
export function baseAt(snaps, minutes) {
  const cutoff = tms(snaps.at(-1)) - minutes * 60_000;
  for (let i = snaps.length - 2; i >= 0; i--) if (tms(snaps[i]) <= cutoff) return snaps[i];
  return snaps[0];
}

const describe = (v, bull, bear, flat = 'neutral') => (v > 0.15 ? bull : v < -0.15 ? bear : flat);

// recentWeight: share of the "last few readings" window. 0.4 for the intraday pulse, 0 for the day bias.
function oiFlowComponent(snaps, width, recentMinutes, recentWeight) {
  const first = snaps[0];
  const curr = snaps.at(-1);
  const recentBase = baseAt(snaps, recentMinutes);
  const session = flowScore(analyzeInterval(first, curr), curr.spot, width);
  const recent = flowScore(analyzeInterval(recentBase, curr), curr.spot, width);
  const value = (1 - recentWeight) * session + recentWeight * recent;
  const sessionText = `OI flow since ${time(first)} ${describe(session, 'bullish (put writing / call covering)', 'bearish (call writing / put covering)', 'balanced')}`;
  return {
    value,
    detail: { session: round(session), recent: round(recent) },
    reason: recentWeight ? `${sessionText}; last ${recentMinutes} min ${describe(recent, 'bullish', 'bearish', 'balanced')}` : sessionText,
  };
}

function priceComponent(snaps, emRemaining, recentWeight) {
  const first = snaps[0];
  const curr = snaps.at(-1);
  const sessionMove = curr.spot - first.spot;
  const recentBase = baseAt(snaps, 15);
  const recentMove = curr.spot - recentBase.spot;
  const scale = Math.max(emRemaining, 1);
  const value = (1 - recentWeight) * Math.tanh(sessionMove / (0.6 * scale)) + recentWeight * Math.tanh(recentMove / (0.3 * scale));
  return {
    value,
    detail: { sessionMove: round(sessionMove, 1), recentMove: round(recentMove, 1) },
    reason: `Spot ${sessionMove >= 0 ? '+' : ''}${round(sessionMove, 1)} pts since first snapshot, ${recentMove >= 0 ? '+' : ''}${round(recentMove, 1)} pts in last ${Math.round((tms(curr) - tms(recentBase)) / 60_000)} min`,
  };
}

function pcrComponent(snaps, window) {
  const now = pcr(snaps.at(-1), window);
  const open = pcr(snaps[0], window);
  if (now == null || open == null) return null;
  const value = 0.5 * Math.tanh((now - 1) * 1.5) + 0.5 * Math.tanh((now - open) * 3);
  return {
    value,
    detail: { pcr: round(now), pcrOpen: round(open) },
    reason: `Near-ATM PCR ${round(now)} (open ${round(open)}) — ${now > open ? 'puts being added faster than calls' : 'calls being added faster than puts'}`,
  };
}

function wallsComponent(curr, sessionRows, step) {
  const { supports, resistances } = sellerLevels(curr, sessionRows, step, 1);
  const s = supports[0];
  const r = resistances[0];
  if (!s || !r || !s.oi || !r.oi) return null;
  const value = Math.tanh(Math.log(s.oi / r.oi));
  return {
    value,
    detail: { support: s.strike, supportOi: s.oi, resistance: r.strike, resistanceOi: r.oi },
    reason: `Put wall ${s.strike} vs call wall ${r.strike}: ${describe(value, 'support is heavier', 'resistance is heavier', 'evenly matched')}`,
  };
}

/** User-supplied support/resistance zones: [{ from, to }]. */
function zonesComponent(spot, zones, step) {
  const breakout = 3 * step; // a break counts while spot is within 3 strikes of the zone
  const sup = zones?.support ?? [];
  const res = zones?.resistance ?? [];
  if (!sup.length && !res.length) return null;
  const lo = (z) => Math.min(z.from, z.to);
  const hi = (z) => Math.max(z.from, z.to);
  const brokeRes = res.find((z) => spot > hi(z) && spot - hi(z) < breakout);
  const brokeSup = sup.find((z) => spot < lo(z) && lo(z) - spot < breakout);
  const inSup = sup.find((z) => spot >= lo(z) && spot <= hi(z));
  const inRes = res.find((z) => spot >= lo(z) && spot <= hi(z));
  if (brokeSup) return { value: -1, reason: `Spot broke below your support ${lo(brokeSup)}–${hi(brokeSup)}` };
  if (brokeRes) return { value: 1, reason: `Spot broke above your resistance ${lo(brokeRes)}–${hi(brokeRes)}` };
  if (inSup) return { value: 0.3, reason: `Spot is inside your support zone ${lo(inSup)}–${hi(inSup)}` };
  if (inRes) return { value: -0.3, reason: `Spot is inside your resistance zone ${lo(inRes)}–${hi(inRes)}` };
  return { value: 0, reason: 'Spot is between your zones' };
}

/** 0–100: how sideways the session looks (100 = strong range). */
function rangeScore(snaps, sessionRows, emRemaining, directionScore, step) {
  const first = snaps[0];
  const curr = snaps.at(-1);
  const ivOpen = atmIv(first);
  const ivNow = atmIv(curr);

  const elapsedYears = (new Date(curr.timestamp) - new Date(first.timestamp)) / MS_PER_YEAR;
  const emElapsed = ivOpen && elapsedYears > 0 ? expectedMove(first.spot, ivOpen, elapsedYears) : null;
  const realized = emElapsed ? 1 - clamp(Math.abs(curr.spot - first.spot) / (1.5 * emElapsed), 0, 1) : 0.5;

  const ivTrend = ivOpen && ivNow ? clamp(0.5 - (ivNow - ivOpen) / 4, 0, 1) : 0.5;

  let peBelow = 0;
  let ceAbove = 0;
  for (const r of sessionRows) {
    if (Math.abs(r.strike - curr.spot) > Math.max(emRemaining, 2 * step)) continue;
    if (r.strike <= curr.spot && r.pe.action === ACTIONS.WRITING) peBelow += r.pe.dOi;
    if (r.strike >= curr.spot && r.ce.action === ACTIONS.WRITING) ceAbove += r.ce.dOi;
  }
  const twoSided = peBelow + ceAbove > 0 ? Math.min(peBelow, ceAbove) / Math.max(peBelow, ceAbove) : 0.5;

  const weak = 1 - Math.abs(directionScore);
  const score = 100 * (0.3 * realized + 0.2 * ivTrend + 0.3 * twoSided + 0.2 * weak);
  return {
    score: round(score, 0),
    detail: {
      realizedVsImplied: round(realized),
      ivChange: ivOpen && ivNow ? round(ivNow - ivOpen) : null,
      twoSidedWriting: round(twoSided),
    },
  };
}

export function labelFor(score) {
  const a = Math.abs(score);
  const dir = score >= 0 ? 'Bullish' : 'Bearish';
  if (a < 12) return 'Sideways';
  if (a < 25) return `Sideways to ${dir}`;
  if (a < 45) return `Mild ${dir}`;
  return dir;
}

function probabilities(score, range) {
  const logits = { bullish: 3 * (score / 100), bearish: -3 * (score / 100), neutral: 2.2 * (range / 100) - 0.2 };
  const exps = Object.fromEntries(Object.entries(logits).map(([k, v]) => [k, Math.exp(v)]));
  const total = exps.bullish + exps.bearish + exps.neutral;
  return {
    bullish: round((100 * exps.bullish) / total, 0),
    neutral: round((100 * exps.neutral) / total, 0),
    bearish: round((100 * exps.bearish) / total, 0),
  };
}

const DAY_HYSTERESIS = 8;
const DAY_HALF_LIFE_MIN = 30; // minutes of clock time, whatever the polling rate

/**
 * The day bias: the session-only score at every reading since the first, smoothed with an exponential moving
 * average (half-life 30 min of clock time — each reading's weight follows the time since the previous one, so
 * 1-minute polling or feed gaps don't speed it up or slow it down) and given a sticky label. Recomputed from the whole series each time, so it is the
 * same after a restart. Returns the latest reading's components with the smoothed score/label/probabilities.
 */
export function dayBias(snaps, opts = {}) {
  let ema = null;
  let label = null;
  let last = null;
  for (let i = 1; i <= snaps.length; i++) {
    last = directionalBias(snaps.slice(0, i), { ...opts, mode: 'day' });
    const dtMin = i > 1 ? Math.max(0, (tms(snaps[i - 1]) - tms(snaps[i - 2])) / 60_000) : 0;
    const alpha = 1 - 0.5 ** (dtMin / DAY_HALF_LIFE_MIN);
    ema = ema == null ? last.score : ema + alpha * (last.score - ema);
    const score = Math.round(ema);
    const fresh = labelFor(score);
    label =
      label && fresh !== label && [labelFor(score - DAY_HYSTERESIS), labelFor(score + DAY_HYSTERESIS)].includes(label) ? label : fresh;
  }
  const score = Math.round(ema);
  return {
    ...last,
    rawScore: last.score,
    score,
    label,
    probabilities: probabilities(score, last.range.score),
  };
}

// Order flow is intentionally not part of the model; it lives on its own Order Flow tab.
export const DEFAULT_WEIGHTS = { oiFlow: 0.4, price: 0.2, pcr: 0.15, walls: 0.1, zones: 0.1 };

/**
 * snaps: session snapshots in time order (≥ 2). Returns score (−100..100), label, probabilities, range score, components.
 */
/**
 * mode "pulse": blends the whole session with the last `recentMinutes` (reacts at every reading).
 * mode "day":   uses only session-level evidence since the first reading, priced against the move expected at the
 *               open, and keeps its previous label unless the score moves clearly into another band (prevLabel).
 */
export function directionalBias(snaps, { weights = DEFAULT_WEIGHTS, zones, step = 50, recentMinutes = 9, mode = 'pulse', prevLabel = null } = {}) {
  const curr = snaps.at(-1);
  const ref = mode === 'day' ? snaps[0] : curr; // day bias scales moves by the expected move at the open, so it doesn't drift as expiry nears
  const iv = atmIv(ref) ?? atmIv(curr) ?? 15;
  const emRemaining = expectedMove(ref.spot, iv, yearsToExpiry(ref.expiry, new Date(ref.timestamp).getTime()));
  const recentWeight = mode === 'day' ? 0 : 0.4;
  const width = Math.max(emRemaining, 3 * step);
  const sessionRows = analyzeInterval(snaps[0], curr);

  const components = {
    oiFlow: oiFlowComponent(snaps, width, recentMinutes, recentWeight),
    price: priceComponent(snaps, emRemaining, recentWeight),
    pcr: pcrComponent(snaps, 2 * width),
    walls: wallsComponent(curr, sessionRows, step),
    zones: zonesComponent(curr.spot, zones, step),
  };

  let num = 0;
  let den = 0;
  for (const [k, c] of Object.entries(components)) {
    if (!c || !weights[k]) continue;
    c.weight = weights[k];
    c.value = round(c.value, 3);
    num += weights[k] * c.value;
    den += weights[k];
  }
  const raw = den ? num / den : 0;
  const score = round(100 * raw, 0);
  const range = rangeScore(snaps, sessionRows, emRemaining, raw, step);

  // Confidence: grows with data and with agreement between components
  const active = Object.values(components).filter((c) => c && c.weight);
  const agree = active.filter((c) => Math.sign(c.value) === Math.sign(raw) || Math.abs(c.value) < 0.1).length;
  const dataFactor = clamp((snaps.length - 1) / 10, 0.2, 1);
  const confidence = round(100 * dataFactor * (active.length ? agree / active.length : 0), 0);

  // hysteresis: a day label only changes once the score is ≥ DAY_HYSTERESIS pts inside the new band
  let label = labelFor(score);
  if (mode === 'day' && prevLabel && label !== prevLabel && [labelFor(score - DAY_HYSTERESIS), labelFor(score + DAY_HYSTERESIS)].includes(prevLabel)) label = prevLabel;

  return {
    mode,
    score,
    label,
    probabilities: probabilities(score, range.score),
    range,
    confidence,
    components,
  };
}
