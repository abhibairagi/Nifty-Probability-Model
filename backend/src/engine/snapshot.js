// The normalized snapshot format every provider must produce. All engine code reads only this shape.
//
// {
//   "timestamp": "2026-10-06T10:03:00+05:30",
//   "symbol": "NIFTY",
//   "expiry": "2026-10-06T15:30:00+05:30",
//   "spot": 22450.5,
//   "futures": 22468, "futuresOi": 12345600,      // optional
//   "vix": 15.16,                                  // optional
//   "atmIv": 18.5,                                 // optional; used when legs carry no IV (e.g. OI-only feeds)
//   "strikes": [
//     { "strike": 22400,
//       "ce": { "oi": 5400000, "ltp": 92.5, "volume": 1200000, "iv": 19.8 },
//       "pe": { "oi": 7100000, "ltp": 41.2, "volume": 1500000, "iv": 20.6 } }
//   ]
// }

const num = (v) => {
  if (v == null || v === '') return null; // Number(null) would be 0 — missing must stay missing
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

function normLeg(leg) {
  if (!leg) return null;
  return {
    oi: num(leg.oi) ?? 0,
    ltp: num(leg.ltp),
    volume: num(leg.volume) ?? 0,
    iv: num(leg.iv),
    prevOi: num(leg.prevOi), // previous day's closing OI, if the feed has it
    oiChange5m: num(leg.oiChange5m), // feed-reported OI change over the last 5 min, if any
    kiteOi: num(leg.kiteOi), // OI from the Kite candle (cross-check), if any
  };
}

/** Validates and cleans a snapshot. Throws with a readable message when unusable. */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('snapshot must be an object');
  const spot = num(raw.spot);
  if (!spot) throw new Error('snapshot.spot is required');
  if (!raw.expiry || Number.isNaN(new Date(raw.expiry).getTime())) throw new Error('snapshot.expiry must be an ISO datetime');
  if (!Array.isArray(raw.strikes) || raw.strikes.length < 3) throw new Error('snapshot.strikes needs at least 3 strikes');

  const timestamp = raw.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString();
  const strikes = raw.strikes
    .map((s) => ({ strike: num(s.strike), ce: normLeg(s.ce), pe: normLeg(s.pe) }))
    .filter((s) => s.strike && s.ce && s.pe)
    .sort((a, b) => a.strike - b.strike);

  return {
    timestamp,
    symbol: String(raw.symbol || 'NIFTY').toUpperCase(),
    expiry: new Date(raw.expiry).toISOString(),
    spot,
    spotSource: raw.spotSource ?? null, // "kite" when spot came from Kite's NIFTY 50 candle
    feedSpot: num(raw.feedSpot), // the provider's own spot, kept for reference when replaced
    forward: num(raw.forward), // synthetic forward for this expiry (put-call parity), when premiums are known
    futures: num(raw.futures),
    futuresOi: num(raw.futuresOi),
    vix: num(raw.vix),
    atmIv: num(raw.atmIv),
    prevClose: num(raw.prevClose),
    strikes,
  };
}

export function atmStrike(snap) {
  let best = snap.strikes[0];
  for (const s of snap.strikes) if (Math.abs(s.strike - snap.spot) < Math.abs(best.strike - snap.spot)) best = s;
  return best;
}

/** ATM IV = average of ATM CE and PE IV (falls back to whichever exists, then to snapshot-level atmIv). */
export function atmIv(snap) {
  const a = atmStrike(snap);
  const ivs = [a.ce.iv, a.pe.iv].filter((v) => v > 0);
  return ivs.length ? ivs.reduce((x, y) => x + y, 0) / ivs.length : snap.atmIv > 0 ? snap.atmIv : null;
}

export function strikeMap(snap) {
  return new Map(snap.strikes.map((s) => [s.strike, s]));
}

export function strikeStep(snap) {
  let step = Infinity;
  for (let i = 1; i < snap.strikes.length; i++) step = Math.min(step, snap.strikes[i].strike - snap.strikes[i - 1].strike);
  return Number.isFinite(step) ? step : 50;
}
