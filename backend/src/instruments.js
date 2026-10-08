// Supported underlyings. Exchanges revise expiry days and strike intervals from time to time; update here when they do.
// expiryWeekday: 0 = Sunday … 6 = Saturday. The engine itself is instrument-agnostic (step is read from the chain).

export const INSTRUMENTS = {
  NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', strikeStep: 50, expiryWeekday: 2, expiryTime: '15:30', mock: { spot: 22450, iv: 20.4, vix: 15.16 } },
  SENSEX: { symbol: 'SENSEX', name: 'BSE SENSEX', exchange: 'BSE', strikeStep: 100, expiryWeekday: 4, expiryTime: '15:30', mock: { spot: 74000, iv: 14.5, vix: 15.16 } },
};

export const DEFAULT_SYMBOL = 'NIFTY';

export function getInstrument(symbol = DEFAULT_SYMBOL) {
  const inst = INSTRUMENTS[String(symbol).toUpperCase()];
  if (!inst) throw new Error(`unknown symbol "${symbol}" (supported: ${Object.keys(INSTRUMENTS).join(', ')})`);
  return inst;
}

/** Next weekly expiry for the instrument (IST) at or after `fromMs`, as an ISO string. */
export function nextExpiry(symbol = DEFAULT_SYMBOL, fromMs = Date.now()) {
  const { expiryWeekday, expiryTime } = getInstrument(symbol);
  const [h, m] = expiryTime.split(':').map(Number);
  const ist = new Date(fromMs + 5.5 * 3600e3);
  for (let add = 0; add < 8; add++) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, h, m) - 5.5 * 3600e3);
    if (new Date(d.getTime() + 5.5 * 3600e3).getUTCDay() === expiryWeekday && d.getTime() > fromMs) return d.toISOString();
  }
  throw new Error('unreachable');
}
