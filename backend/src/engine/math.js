// Core statistics: normal CDF, lognormal OTM probability, expected move, time to expiry.

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// Abramowitz & Stegun 7.1.26 approximation of erf (max error ~1.5e-7)
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Years remaining until expiry (calendar time, same as Spot × IV × √(days/365)). Floors at 1 minute. */
export function yearsToExpiry(expiryIso, nowMs = Date.now()) {
  const ms = new Date(expiryIso).getTime() - nowMs;
  return Math.max(ms, 60_000) / MS_PER_YEAR;
}

/** 1σ expected move in points. iv is a percentage (e.g. 20.4). */
export function expectedMove(spot, ivPct, years) {
  return spot * (ivPct / 100) * Math.sqrt(years);
}

/**
 * Probability the underlying finishes ABOVE strike at expiry (lognormal, r = 0).
 * P(S_T > K) = N(d2), d2 = (ln(S/K) − σ²T/2) / (σ√T)
 */
export function probAbove(spot, strike, ivPct, years) {
  const sigma = ivPct / 100;
  if (!(sigma > 0) || !(years > 0)) return spot > strike ? 1 : 0;
  const sqT = sigma * Math.sqrt(years);
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * years) / sqT;
  return normCdf(d2);
}

/** Probability an option expires OTM. CE is OTM if S_T < K, PE is OTM if S_T > K. */
export function probOtm(type, spot, strike, ivPct, years) {
  const above = probAbove(spot, strike, ivPct, years);
  return type === 'CE' ? 1 - above : above;
}

export const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Black-Scholes option price (r = 0). Used by the mock simulator. */
export function bsPrice(type, spot, strike, ivPct, years) {
  const sigma = ivPct / 100;
  if (!(sigma > 0) || !(years > 0)) return Math.max(0, type === 'CE' ? spot - strike : strike - spot);
  const sqT = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * years) / sqT;
  const d2 = d1 - sqT;
  return type === 'CE'
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
}

/** Black-Scholes delta (r = 0): CE in [0, 1], PE in [−1, 0]. */
export function bsDelta(type, spot, strike, ivPct, years) {
  const sigma = ivPct / 100;
  if (!(sigma > 0) || !(years > 0)) return type === 'CE' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * years) / (sigma * Math.sqrt(years));
  return type === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
}

/**
 * Implied volatility (%) from an option price by bisection (r = 0). Returns null when the price carries no usable
 * time value (≤ intrinsic + minTimeValue) — deep ITM/OTM ticks on expiry day are too noisy to invert.
 */
export function impliedVol(type, spot, strike, years, price, { minTimeValue = 0.25, lo = 0.5, hi = 300 } = {}) {
  if (!(price > 0) || !(years > 0)) return null;
  const intrinsic = Math.max(0, type === 'CE' ? spot - strike : strike - spot);
  if (price - intrinsic < minTimeValue) return null;
  if (bsPrice(type, spot, strike, hi, years) < price) return null;
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (bsPrice(type, spot, strike, m, years) > price) b = m;
    else a = m;
  }
  return (a + b) / 2;
}
