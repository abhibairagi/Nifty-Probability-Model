// Generates a full simulated expiry-day session (09:15 → 15:30, every 3 min) into the "sim" bucket,
// so the dashboard can be explored with ?date=sim before the real API is connected.
//   node scripts/simulate.js [--symbol NIFTY|SENSEX] [--seed 42] [--spot 22450] [--iv 20.4] [--until 13:00]

import { createMockMarket } from '../src/providers/mock.js';
import { ingest } from '../src/service.js';
import * as store from '../src/store.js';
import { getInstrument, nextExpiry } from '../src/instruments.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const BUCKET = 'sim';
const { symbol } = getInstrument(args.symbol || 'NIFTY');
const expiry = nextExpiry(symbol, new Date('2026-10-05T12:00:00+05:30').getTime()); // the coming weekly expiry
const day = store.istDate(expiry);
const [uh, um] = (args.until || '15:30').split(':').map(Number);

const market = createMockMarket({
  symbol,
  spot: Number(args.spot) || undefined,
  iv: Number(args.iv) || undefined,
  seed: Number(args.seed) || 42,
  expiry,
});

store.clearBucket(symbol, BUCKET);
let report;
for (let m = 9 * 60 + 15; m <= uh * 60 + um; m += 3) {
  const ts = new Date(`${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+05:30`).getTime();
  report = ingest(market.tick(ts), BUCKET);
}
console.log(`Simulated ${symbol} ${day}: ${report.snapshotCount} snapshots → data/${symbol}/snapshots/${BUCKET}.json`);
console.log(`Last: spot ${report.market.spot} | ${report.bias.label} (${report.bias.score}) | bull ${report.bias.probabilities.bullish}% / neutral ${report.bias.probabilities.neutral}% / bear ${report.bias.probabilities.bearish}%`);
console.log(`Support ${report.levels.support} | Resistance ${report.levels.resistance} | Zone ${report.expectedRange.expiryZoneLow}–${report.expectedRange.expiryZoneHigh}`);
console.log(`Suggested: CE ${report.suggestions.ce?.strike ?? '-'} / PE ${report.suggestions.pe?.strike ?? '-'} (≥${report.suggestions.targetProb}% OTM)`);
