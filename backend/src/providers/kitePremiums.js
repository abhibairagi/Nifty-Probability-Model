// Adds Kite data to an OI snapshot, all from 1-minute candles at the snapshot's minute:
//   • NIFTY 50 spot — replaces the feed's spot (Sensibull's spot can be stale, e.g. yesterday's close at 09:15),
//     so spot and premiums come from the same minute and implied vols are consistent
//   • every strike's CE/PE premium (→ ltp, day volume, Kite OI), the synthetic forward (put-call parity) and each
//     strike's implied volatility against that forward
//   • the near-month NIFTY future (price + OI)
// The same enricher serves SENSEX (name: 'SENSEX'): BSE SENSEX index spot, BFO options and the SENSEX future.

import { findOption, nearestFuture } from './kiteInstruments.js';
import { loadKiteSession, KITE_TOKENS } from './kite.js';
import { impliedVol, yearsToExpiry, round } from '../engine/math.js';

const INDEX_TOKEN = { NIFTY: KITE_TOKENS.NIFTY_50, SENSEX: KITE_TOKENS.SENSEX };

const istDate = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

export function createPremiumEnricher(candles, { name = 'NIFTY' } = {}) {
  let lastResult = null;

  async function enrich(raw) {
    if (!loadKiteSession() || !raw?.strikes?.length) return raw;
    const ts = new Date(raw.timestamp).getTime();
    const expiryDate = istDate(new Date(raw.expiry).getTime());
    const years = yearsToExpiry(raw.expiry, ts);
    let priced = 0;
    let missing = 0;
    try {
      if (raw.spotSource !== 'kite') {
        const idx = await candles.candleAt(INDEX_TOKEN[name] ?? KITE_TOKENS.NIFTY_50, ts);
        if (idx) {
          raw.feedSpot ??= raw.spot;
          raw.spot = idx.close;
          raw.spotSource = 'kite';
        }
      }
      for (const s of raw.strikes) {
        for (const [side, type] of [['ce', 'CE'], ['pe', 'PE']]) {
          const leg = s[side];
          if (!leg || leg.ltp != null) continue;
          {
            const inst = findOption(name, expiryDate, s.strike, type);
            if (!inst) {
              missing++;
              continue;
            }
            const c = await candles.candleAt(inst.token, ts);
            if (!c) continue;
            leg.ltp = c.close;
            leg.volume = c.dayVolume;
            leg.kiteOi = c.oi;
            priced++;
          }
        }
      }

      // Options price off the forward, not spot. Synthetic forward from put-call parity (r ≈ 0): F = K + C − P,
      // median over the 3 strikes nearest spot. IVs are then implied against F.
      const near = raw.strikes
        .filter((k) => k.ce.ltp != null && k.pe.ltp != null)
        .sort((a, b) => Math.abs(a.strike - raw.spot) - Math.abs(b.strike - raw.spot))
        .slice(0, 3)
        .map((k) => k.strike + k.ce.ltp - k.pe.ltp)
        .sort((a, b) => a - b);
      raw.forward = near.length ? round(near[Math.floor(near.length / 2)], 2) : null;
      const under = raw.forward ?? raw.spot;
      for (const s of raw.strikes) {
        for (const [side, type] of [['ce', 'CE'], ['pe', 'PE']]) {
          const leg = s[side];
          if (leg?.ltp == null) continue;
          const iv = impliedVol(type, under, s.strike, years, leg.ltp);
          leg.iv = iv != null ? round(iv, 2) : null;
        }
      }
      const fut = nearestFuture(name, istDate(ts));
      if (fut && raw.futures == null) {
        const c = await candles.candleAt(fut.token, ts);
        if (c) {
          raw.futures = c.close;
          raw.futuresOi = c.oi;
        }
      }
      lastResult = { ok: true, at: new Date().toISOString(), priced, missing, dataTime: raw.timestamp };
    } catch (e) {
      lastResult = { ok: false, at: new Date().toISOString(), error: e.message };
    }
    return raw;
  }

  return { enrich, status: () => lastResult };
}
