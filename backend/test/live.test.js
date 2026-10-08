import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/engine/index.js';
import { createMockMarket } from '../src/providers/mock.js';

const expiry = '2026-10-06T15:30:00+05:30';
const start = new Date('2026-10-06T09:15:00+05:30').getTime();

function session(n = 10) {
  const m = createMockMarket({ seed: 11, expiry });
  return Array.from({ length: n }, (_, i) => m.tick(start + i * 180_000));
}

test('newer 1-minute prices re-price the report; OI-based parts are unchanged', () => {
  const snaps = session();
  const base = analyze(snaps);
  const curr = snaps.at(-1);
  const live = {
    timestamp: new Date(new Date(curr.timestamp).getTime() + 60_000).toISOString(),
    expiry: curr.expiry,
    spot: curr.spot + 40,
    forward: curr.spot + 45,
    vix: 16.2,
    strikes: curr.strikes.map((s) => ({ strike: s.strike, ce: { ltp: s.ce.ltp + 20, iv: s.ce.iv }, pe: { ltp: Math.max(0.05, s.pe.ltp - 15), iv: s.pe.iv } })),
  };
  const r = analyze(snaps, {}, null, live);
  assert.equal(r.pricedAt, live.timestamp);
  assert.equal(r.timestamp, base.timestamp); // OI reading time unchanged
  assert.equal(r.market.spot, live.spot);
  assert.equal(r.market.vix, 16.2);
  assert.notEqual(r.expectedRange.lower1, base.expectedRange.lower1);
  assert.deepEqual(r.levels, base.levels); // seller positioning comes from OI only
  assert.equal(r.dayBias.score, base.dayBias.score); // day bias unaffected by minute prices
});

test('older or other-expiry minute prices are ignored', () => {
  const snaps = session();
  const base = analyze(snaps);
  const curr = snaps.at(-1);
  const stale = { timestamp: snaps[0].timestamp, expiry: curr.expiry, spot: 1, strikes: [] };
  const other = { timestamp: new Date(Date.now() + 1e9).toISOString(), expiry: '2026-10-13T10:00:00.000Z', spot: 1, strikes: [] };
  assert.equal(analyze(snaps, {}, null, stale).market.spot, base.market.spot);
  assert.equal(analyze(snaps, {}, null, other).market.spot, base.market.spot);
});
