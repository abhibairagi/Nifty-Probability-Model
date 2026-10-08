// OI-change classification and seller support/resistance detection.
//
//   OI ↑  premium ↓/flat  → WRITING         (fresh shorts: sellers defending)
//   OI ↑  premium ↑       → LONG_BUILDUP    (fresh longs: buyers chasing)
//   OI ↓  premium ↑/flat  → SHORT_COVERING  (sellers exiting: wall weakening)
//   OI ↓  premium ↓       → LONG_UNWINDING  (buyers exiting)
//
// "Premium" here is the premium change NET of what spot movement + time decay explain at unchanged IV
// (full Black-Scholes reprice, so expiry-day gamma and theta are included). Otherwise a falling market
// makes every put look like "long buildup" just because puts gain value. The residual ≈ IV pressure.
//
// Premium evidence must be strong (net move ≥ minPremiumMovePct of the premium and ≥ ₹minPremiumMove) to call
// buyers (long buildup / unwinding); otherwise index-option OI change is read the standard way — OI↑ = writing,
// OI↓ = covering. Small IV drift over a long window must not turn a huge put build into "long buildup".
//
// Every option trade has a buyer and a seller, so this is an inference from OI + premium, not certainty.

import { strikeMap } from './snapshot.js';
import { bsPrice, yearsToExpiry } from './math.js';

export const ACTIONS = {
  WRITING: 'writing',
  LONG_BUILDUP: 'long_buildup',
  SHORT_COVERING: 'short_covering',
  LONG_UNWINDING: 'long_unwinding',
  NONE: 'none',
};

/** `spotEffect` = premium change explained by spot move + time decay at unchanged IV; 0 if unknown. */
export function classifyLeg(
  prevLeg,
  currLeg,
  { minOiChangePct = 0.5, minOiChangeAbs = 5000, minPremiumMovePct = 8, minPremiumMove = 1 } = {},
  spotEffect = 0,
) {
  const dOi = currLeg.oi - prevLeg.oi;
  const hasPremium = currLeg.ltp != null && prevLeg.ltp != null;
  const rawDLtp = hasPremium ? currLeg.ltp - prevLeg.ltp : 0;
  const dLtp = rawDLtp - (hasPremium ? spotEffect : 0);
  const strong = hasPremium && Math.abs(dLtp) >= Math.max(minPremiumMove, (prevLeg.ltp * minPremiumMovePct) / 100);
  const threshold = Math.max(minOiChangeAbs, (prevLeg.oi * minOiChangePct) / 100);
  let action = ACTIONS.NONE;
  if (dOi >= threshold) action = strong && dLtp > 0 ? ACTIONS.LONG_BUILDUP : ACTIONS.WRITING;
  else if (dOi <= -threshold) action = strong && dLtp < 0 ? ACTIONS.LONG_UNWINDING : ACTIONS.SHORT_COVERING;
  return {
    oi: currLeg.oi,
    dOi,
    dOiPct: prevLeg.oi ? (dOi / prevLeg.oi) * 100 : null,
    ltp: currLeg.ltp,
    dLtp: rawDLtp,
    dLtpNet: dLtp,
    iv: currLeg.iv,
    dIv: currLeg.iv != null && prevLeg.iv != null ? currLeg.iv - prevLeg.iv : null,
    action,
  };
}

/** Per-strike classification between two snapshots (only strikes present in both). */
export function analyzeInterval(prev, curr, opts) {
  const prevMap = strikeMap(prev);
  const y0 = yearsToExpiry(prev.expiry, new Date(prev.timestamp).getTime());
  const y1 = yearsToExpiry(curr.expiry, new Date(curr.timestamp).getTime());
  // model premium change holding the start IV fixed (differences of the model, so its pricing bias cancels)
  const u0 = prev.forward ?? prev.spot; // price off the forward when the snapshot has one
  const u1 = curr.forward ?? curr.spot;
  const effect = (type, leg, strike) =>
    leg.iv > 0 ? bsPrice(type, u1, strike, leg.iv, y1) - bsPrice(type, u0, strike, leg.iv, y0) : 0;
  const rows = [];
  for (const s of curr.strikes) {
    const p = prevMap.get(s.strike);
    if (!p) continue;
    rows.push({
      strike: s.strike,
      ce: classifyLeg(p.ce, s.ce, opts, effect('CE', p.ce, s.strike)),
      pe: classifyLeg(p.pe, s.pe, opts, effect('PE', p.pe, s.strike)),
    });
  }
  return rows;
}

/** OI-weighted put/call ratio, optionally limited to ±window points around spot. */
export function pcr(snap, window = Infinity) {
  let ce = 0;
  let pe = 0;
  for (const s of snap.strikes) {
    if (Math.abs(s.strike - snap.spot) > window) continue;
    ce += s.ce.oi;
    pe += s.pe.oi;
  }
  return ce ? pe / ce : null;
}

/**
 * Seller walls. Support = highest-OI PE strikes at/below spot; resistance = highest-OI CE strikes at/above spot.
 * `sessionRows` (open → now classification) adds how much of that OI was built today.
 */
export function sellerLevels(snap, sessionRows = [], step = 50, top = 3) {
  const session = new Map(sessionRows.map((r) => [r.strike, r]));
  const pick = (side, filter) =>
    snap.strikes
      .filter(filter)
      .map((s) => ({
        strike: s.strike,
        oi: s[side].oi,
        sessionDOi: session.get(s.strike)?.[side].dOi ?? 0,
        sessionAction: session.get(s.strike)?.[side].action ?? ACTIONS.NONE,
      }))
      .sort((a, b) => b.oi - a.oi)
      .slice(0, top);

  return {
    supports: pick('pe', (s) => s.strike <= snap.spot + step / 2),
    resistances: pick('ce', (s) => s.strike >= snap.spot - step / 2),
  };
}

/** Largest fresh writing during the session (where sellers are actively building today). */
export function topWriting(sessionRows, side, n = 3) {
  return sessionRows
    .filter((r) => r[side].dOi > 0)
    .sort((a, b) => b[side].dOi - a[side].dOi)
    .slice(0, n)
    .map((r) => ({ strike: r.strike, dOi: r[side].dOi, action: r[side].action }));
}
