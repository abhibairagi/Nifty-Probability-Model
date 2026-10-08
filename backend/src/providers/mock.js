// Mock market simulator: produces realistic option-chain snapshots for any instrument so the model
// and dashboard can be exercised before the real API is connected.
// Sellers react to price: when spot rises they write puts below and cover calls near spot (and vice versa).
// Heavy writing at a strike leans on its premium (IV dips); covering lifts it.

import { bsPrice, yearsToExpiry, round } from '../engine/math.js';
import { getInstrument, nextExpiry } from '../instruments.js';

function gaussRandom(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

// Small seeded PRNG so simulations are reproducible
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMockMarket({ symbol = 'NIFTY', spot, iv, vix, expiry, seed = Date.now(), drift = 0 } = {}) {
  const inst = getInstrument(symbol);
  spot ??= inst.mock.spot;
  iv ??= inst.mock.iv;
  vix ??= inst.mock.vix;
  const baseIv = iv;
  const rand = mulberry32(seed);
  const step = inst.strikeStep;
  const unit = step / 50; // distances below are written in NIFTY points and scaled per instrument
  const center = Math.round(spot / (2 * step)) * 2 * step;
  const strikes = [];
  for (let k = center - 20 * step; k <= center + 20 * step; k += step) strikes.push(k);

  // Initial OI: round strikes get more, CE heavier above spot, PE heavier below
  const oi = new Map(
    strikes.map((k) => {
      const dist = (k - spot) / (300 * unit);
      const roundStrike = k % (2 * step) === 0 ? 1.6 : 1;
      const base = 2_000_000 * roundStrike;
      return [
        k,
        {
          ce: Math.round(base * (k >= spot ? 1.4 : 0.5) * Math.exp(-0.5 * (dist - 1) ** 2) * (0.7 + 0.6 * rand())) + 50_000,
          pe: Math.round(base * (k <= spot ? 1.4 : 0.5) * Math.exp(-0.5 * (dist + 1) ** 2) * (0.7 + 0.6 * rand())) + 50_000,
        },
      ];
    }),
  );
  const volume = new Map(strikes.map((k) => [k, { ce: 0, pe: 0 }]));
  const pressure = new Map(strikes.map((k) => [k, { ce: 0, pe: 0 }])); // IV offset from recent writing/covering
  let cumDelta = 0;
  let regimeDrift = drift * unit; // points per tick bias

  return {
    symbol: inst.symbol,
    /** Advance one tick (3 min by default) and return a raw normalized snapshot. */
    tick(nowMs = Date.now(), minutes = 3) {
      if (rand() < 0.08) regimeDrift = (rand() - 0.5) * 8 * unit; // occasional regime change
      const move = regimeDrift + gaussRandom(rand) * spot * (iv / 100) * Math.sqrt(minutes / (365 * 24 * 60)) * 1.6;
      const prevSpot = spot;
      spot = Math.max(1000, spot + move);
      // ATM IV mean-reverts to its base, with a kick on big moves
      iv = Math.max(8, iv + 0.15 * (baseIv - iv) + gaussRandom(rand) * 0.25 + (Math.abs(move) > 30 * unit ? 0.5 : 0));
      vix = Math.max(9, vix + gaussRandom(rand) * 0.05);
      cumDelta += Math.round((move / unit) * 800 + gaussRandom(rand) * 5000);

      const up = (spot - prevSpot) / unit;
      for (const k of strikes) {
        const o = oi.get(k);
        const near = Math.exp(-0.5 * ((k - spot) / (200 * unit)) ** 2);
        const noise = () => gaussRandom(rand) * 20_000 * near;
        const peWrite = (k <= spot ? 1 : 0.2) * near * (60_000 + Math.max(0, up) * 4000);
        const ceWrite = (k >= spot ? 1 : 0.2) * near * (60_000 + Math.max(0, -up) * 4000);
        const peCover = k <= spot + step && up < 0 ? near * -up * 5000 : 0;
        const ceCover = k >= spot - step && up > 0 ? near * up * 5000 : 0;
        const dPe = peWrite - peCover + noise();
        const dCe = ceWrite - ceCover + noise();
        o.pe = Math.max(10_000, Math.round(o.pe + dPe));
        o.ce = Math.max(10_000, Math.round(o.ce + dCe));
        const pr = pressure.get(k);
        pr.pe = 0.6 * pr.pe - dPe / 200_000; // net writing pushes IV down, covering pushes it up
        pr.ce = 0.6 * pr.ce - dCe / 200_000;
        const v = volume.get(k);
        v.ce += Math.round(near * 300_000 * (1 + rand()));
        v.pe += Math.round(near * 300_000 * (1 + rand()));
      }

      const years = yearsToExpiry(expiry, nowMs);
      const smile = (k) => iv + Math.max(0, (spot - k) / spot) * 40 + (Math.abs(k - spot) / spot) * 10; // put skew + smile
      const leg = (type, k) => {
        const kIv = Math.max(5, smile(k) + pressure.get(k)[type.toLowerCase()]);
        return {
          oi: oi.get(k)[type.toLowerCase()],
          ltp: round(Math.max(0.05, bsPrice(type, spot, k, kIv, years)), 2),
          volume: volume.get(k)[type.toLowerCase()],
          iv: round(kIv, 2),
        };
      };
      return {
        timestamp: new Date(nowMs).toISOString(),
        symbol: inst.symbol,
        expiry,
        spot: round(spot, 2),
        futures: round(spot + 15 * unit, 2),
        vix: round(vix, 2),
        orderFlow: { cumDelta },
        strikes: strikes.map((k) => ({ strike: k, ce: leg('CE', k), pe: leg('PE', k) })),
      };
    },
  };
}

/** Provider interface: { name, symbol, fetchSnapshot(): Promise<rawSnapshot> } */
export function createMockProvider(symbol = 'NIFTY', opts = {}) {
  const expiry = opts.expiry || nextExpiry(symbol);
  const market = createMockMarket({ ...opts, symbol, expiry });
  return { name: 'mock', symbol: market.symbol, fetchSnapshot: async () => market.tick(Date.now()) };
}
