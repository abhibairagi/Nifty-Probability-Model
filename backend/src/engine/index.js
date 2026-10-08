// Assembles the full analysis report from a session's snapshots.

import { atmIv, atmStrike, strikeStep } from './snapshot.js';
import { analyzeInterval, pcr, sellerLevels, topWriting } from './oiAnalyzer.js';
import { directionalBias, dayBias as computeDayBias, DEFAULT_WEIGHTS, baseAt } from './direction.js';
import { strikeSafety, suggestShortStrikes } from './strikeSafety.js';
import { buildAlerts } from './alerts.js';
import { expectedMove, yearsToExpiry, round } from './math.js';

export const DEFAULT_CONFIG = {
  weights: DEFAULT_WEIGHTS,
  zones: { support: [], resistance: [] }, // your manual S/R, e.g. [{ "from": 22300, "to": 22350 }]
  targetProbOtm: 85, // % — minimum OTM probability for a suggested short strike
  biasTilt: 0.3, // how far (× expected move) the bias shifts spot for adjusted probabilities
  recentMinutes: 9, // "recent" window (strike "Last 9m", pulse, alerts) — clock minutes, any polling rate
  strikeWindowSigma: 2.5, // show strikes within ±N × expected move
  atmIvOverride: null, // % — used when the feed has no option IV (e.g. Sensibull OI endpoints)
};

/** Where the ATM IV comes from: the chain itself, the manual override, India VIX, or a 15% default. */
function withIv(snaps, override) {
  const first = snaps.at(-1);
  if (first.strikes.some((s) => s.ce.iv > 0 || s.pe.iv > 0)) return { snaps, source: 'option chain' };
  if (override > 0) return { snaps: snaps.map((s) => ({ ...s, atmIv: override })), source: 'manual (settings)' };
  if (first.atmIv > 0) return { snaps, source: 'feed' };
  if (first.vix > 0) return { snaps: snaps.map((s) => ({ ...s, atmIv: s.vix ?? first.vix })), source: 'India VIX (proxy)' };
  return { snaps: snaps.map((s) => ({ ...s, atmIv: 15 })), source: 'default 15% — set ATM IV in Settings' };
}

/**
 * The latest OI reading re-priced with the newest 1-minute prices (spot, forward, VIX, future, premiums, IVs).
 * OI and seller positioning stay as of the OI reading; prices, probabilities and ranges use the minute data.
 */
function priceView(curr, live) {
  if (!live || live.expiry !== curr.expiry || live.timestamp <= curr.timestamp) return curr;
  const byStrike = new Map(live.strikes.map((s) => [s.strike, s]));
  return {
    ...curr,
    timestamp: live.timestamp,
    spot: live.spot ?? curr.spot,
    forward: live.forward ?? curr.forward,
    futures: live.futures ?? curr.futures,
    vix: live.vix ?? curr.vix,
    strikes: curr.strikes.map((s) => {
      const l = byStrike.get(s.strike);
      if (!l) return s;
      return {
        ...s,
        ce: { ...s.ce, ltp: l.ce.ltp ?? s.ce.ltp, iv: l.ce.iv ?? s.ce.iv },
        pe: { ...s.pe, ltp: l.pe.ltp ?? s.pe.ltp, iv: l.pe.iv ?? s.pe.iv },
      };
    }),
  };
}

/**
 * @param snaps      session snapshots (normalized, time-ordered, same expiry)
 * @param config     merged with DEFAULT_CONFIG
 * @param prevReport previous report (for migration / flip alerts)
 * @param live       newest 1-minute prices ({ timestamp, expiry, spot, forward, futures, vix, strikes }), optional
 * @param sb         newest Sensibull intraday reading ({ polledAt, expiry, atmIv, ivp, maxPain, straddle, … }), optional
 */
export function analyze(rawSnaps, config = {}, prevReport = null, live = null, sb = null) {
  if (!rawSnaps.length) throw new Error('no snapshots');
  const cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_WEIGHTS, ...config.weights } };
  const { snaps, source: ivSource } = withIv(rawSnaps, Number(cfg.atmIvOverride));
  const first = snaps[0];
  const curr = snaps.at(-1); // OI as of the last OI reading
  const px = priceView(curr, live); // …priced with the newest minute data
  const step = strikeStep(curr);
  const nowMs = new Date(px.timestamp).getTime();
  const years = yearsToExpiry(px.expiry, nowMs);
  // ATM IV: Sensibull's live ATM IV for this expiry when fresh (≤ 20 min), else our own (from premiums), etc.
  const chainIv = atmIv(px) ?? atmIv(curr);
  const expiryDate = new Date(new Date(curr.expiry).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const sbFresh =
    sb?.atmIv > 0 && sb.expiry === expiryDate && Math.abs(new Date(sb.polledAt ?? sb.t).getTime() - nowMs) <= 20 * 60_000;
  const iv = sbFresh ? sb.atmIv : chainIv ?? 15;
  const em = expectedMove(px.spot, iv, years);
  const atm = atmStrike(px);

  const sessionRows = analyzeInterval(first, curr);
  const recentBase = baseAt(snaps, cfg.recentMinutes);
  const recentRows = analyzeInterval(recentBase, curr);
  const lastRows = snaps.length > 1 ? analyzeInterval(snaps.at(-2), curr) : [];

  // dayBias = the headline view for the whole session; bias = the faster "pulse" (session + last 9 min)
  const dayBias = computeDayBias(snaps, { weights: cfg.weights, zones: cfg.zones, step });
  const bias = directionalBias(snaps, { weights: cfg.weights, zones: cfg.zones, step, recentMinutes: cfg.recentMinutes });
  const levels = sellerLevels(curr, sessionRows, step);
  const openLevels = sellerLevels(first, [], step);

  const safety = strikeSafety(px, {
    years,
    atmIvPct: iv,
    biasScore: dayBias.score, // strike probabilities tilt with the stable day bias, not the pulse
    sessionRows,
    recentRows,
    tilt: cfg.biasTilt,
    window: cfg.strikeWindowSigma * Math.max(em, 2 * step),
  });

  // Expected expiry zone: inside the 1σ range, bounded by the seller walls when they sit inside it
  const lower1 = px.spot - em;
  const upper1 = px.spot + em;
  const sup = levels.supports[0]?.strike;
  const res = levels.resistances[0]?.strike;
  const zoneLow = sup != null && sup > lower1 ? sup : lower1;
  const zoneHigh = res != null && res < upper1 ? res : upper1;
  const straddle = atm.ce.ltp != null && atm.pe.ltp != null ? atm.ce.ltp + atm.pe.ltp : null;

  const report = {
    generatedAt: new Date().toISOString(),
    timestamp: curr.timestamp, // last OI reading
    pricedAt: px.timestamp, // last price update (1-minute data when available)
    symbol: curr.symbol,
    expiry: curr.expiry,
    snapshotCount: snaps.length,
    sessionStart: first.timestamp,
    market: {
      spot: px.spot,
      spotOpen: first.spot,
      forward: px.forward,
      futures: px.futures,
      vix: px.vix,
      vixOpen: snaps.find((s) => s.vix != null)?.vix ?? null,
      atmStrike: atm.strike,
      atmIv: round(iv),
      ivSource: sbFresh ? 'Sensibull live ATM IV' : ivSource,
      chainAtmIv: round(chainIv), // our own ATM IV from the premiums, for comparison
      ivp: sbFresh ? sb.ivp : null,
      maxPain: sbFresh ? sb.maxPain : null,
      sensibullStraddle: sbFresh ? sb.straddle : null,
      hasPremiums: px.strikes.some((s) => s.ce.ltp != null),
      atmIvOpen: round(atmIv(first)),
      hoursToExpiry: round(years * 365 * 24, 2),
      pcr: round(pcr(curr)),
      pcrNearAtm: round(pcr(curr, 2 * Math.max(em, 2 * step))),
      step,
    },
    expectedRange: {
      move1: round(em, 1),
      lower1: round(lower1, 0),
      upper1: round(upper1, 0),
      lower2: round(px.spot - 2 * em, 0),
      upper2: round(px.spot + 2 * em, 0),
      straddle: round(straddle, 1),
      straddleLower: straddle != null ? round(px.spot - straddle, 0) : null,
      straddleUpper: straddle != null ? round(px.spot + straddle, 0) : null,
      expiryZoneLow: round(zoneLow, 0),
      expiryZoneHigh: round(zoneHigh, 0),
    },
    dayBias,
    bias,
    levels: {
      support: sup ?? null,
      resistance: res ?? null,
      supportOpen: openLevels.supports[0]?.strike ?? null,
      resistanceOpen: openLevels.resistances[0]?.strike ?? null,
      supports: levels.supports,
      resistances: levels.resistances,
      topPutWriting: topWriting(sessionRows, 'pe'),
      topCallWriting: topWriting(sessionRows, 'ce'),
    },
    strikes: safety,
    suggestions: suggestShortStrikes(safety, cfg.targetProbOtm),
    lastInterval: lastRows.filter((r) => Math.abs(r.strike - curr.spot) <= Math.max(2.5 * em, 10 * step)),
    oiChart: curr.strikes
      .filter((s) => Math.abs(s.strike - curr.spot) <= Math.max(2.5 * em, 10 * step))
      .map((s) => {
        const r = sessionRows.find((x) => x.strike === s.strike);
        return {
          strike: s.strike,
          ceOi: s.ce.oi,
          peOi: s.pe.oi,
          ceDOi: r?.ce.dOi ?? 0,
          peDOi: r?.pe.dOi ?? 0,
          ce5m: s.ce.oiChange5m,
          pe5m: s.pe.oiChange5m,
          cePrev: s.ce.prevOi,
          pePrev: s.pe.prevOi,
        };
      }),
  };

  report.alerts = buildAlerts({ curr, prevReport, levels, recentRows, em, step, bias: dayBias });
  return report;
}
