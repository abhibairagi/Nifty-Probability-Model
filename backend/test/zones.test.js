import test from 'node:test';
import assert from 'node:assert/strict';
import { to15m, aggressionEvents, buildZones, analyzeTest, statusHistory } from '../src/orderflow/zones.js';

const T0 = Math.floor(new Date('2026-10-05T09:15:00+05:30').getTime() / 1000);
// one-minute candle with all volume at one price
function m(i, lo, hi, buy, sell, at = (lo + hi) / 2) {
  const d = new Date((T0 + i * 60) * 1000 + 5.5 * 3600e3).toISOString();
  return {
    t: T0 + i * 60,
    time: `${d.slice(0, 10)} ${d.slice(11, 19)}`,
    high: hi,
    low: lo,
    buy_volume: buy,
    sell_volume: sell,
    total_volume: buy + sell,
    delta: buy - sell,
    levels: [{ price: at, buy_volume: buy, sell_volume: sell }],
  };
}
const quiet = (i, p) => m(i, p - 2, p + 2, 100, 100);

test('15-minute bars aggregate minutes and take closes from the map', () => {
  const mins = Array.from({ length: 30 }, (_, i) => quiet(i, 22500));
  const bars = to15m(mins, { closes: new Map([[T0, 22501]]) });
  assert.equal(bars.length, 2);
  assert.equal(bars[0].total, 15 * 200);
  assert.equal(bars[0].close, 22501);
});

test('aggressive selling makes a supply zone at the level where selling concentrated', () => {
  const mins = [];
  for (let i = 0; i < 90; i++) mins.push(quiet(i, 22500)); // 6 quiet bars
  for (let i = 90; i < 105; i++) mins.push(m(i, 22600, 22612, 50, 2000, 22610)); // heavy selling at 22610
  const bars = to15m(mins);
  const ev = aggressionEvents(bars, { topShare: 0.2 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, 'supply');
  const [z] = buildZones(ev, { nowSec: T0 + 105 * 60 });
  assert.ok(z.low <= 22610 && z.high >= 22610);
  assert.equal(z.origin, 'supply');
});

test('heavy buying that closes at the bar low is absorption (supply at the bar high)', () => {
  const mins = [];
  for (let i = 0; i < 90; i++) mins.push(quiet(i, 22500));
  for (let i = 90; i < 105; i++) mins.push(m(i, 22580, 22620, 2000, 50, 22600));
  const bars = to15m(mins, { closes: new Map([[T0 + 6 * 900, 22582]]) }); // closed near the low
  const ev = aggressionEvents(bars, { topShare: 0.2 });
  assert.equal(ev[0].side, 'supply');
  assert.equal(ev[0].kind, 'absorption');
  assert.equal(ev[0].price, 22620);
});

const zone = { low: 22600, high: 22615 };

test('resistance test: sellers defend and price drops away → rejected', () => {
  const mins = [quiet(0, 22570), quiet(1, 22585), m(2, 22595, 22608, 100, 900), m(3, 22580, 22600, 50, 700), quiet(4, 22575)];
  const r = analyzeTest(zone, mins, [], 22575);
  assert.equal(r.role, 'resistance');
  assert.equal(r.status, 'rejected');
});

test('resistance test: buyers aggressive but price falls back → absorbed', () => {
  const mins = [quiet(0, 22570), m(1, 22595, 22612, 1500, 100), m(2, 22585, 22605, 900, 200), quiet(3, 22570)];
  assert.equal(analyzeTest(zone, mins, [], 22570).status, 'absorbed');
});

test('resistance test: 15-min close above with buyers → breakout; then back inside → failed breakout', () => {
  const mins = [quiet(0, 22580)];
  for (let i = 1; i < 15; i++) mins.push(m(i, 22605, 22630, 1200, 300));
  const bars = [{ t: T0, close: 22628 }];
  assert.equal(analyzeTest(zone, mins, bars, 22628).status, 'breakout');
  mins.push(m(15, 22598, 22612, 200, 900));
  assert.equal(analyzeTest(zone, mins, bars, 22605).status, 'failed breakout');
});

test('support test from above: buyers defend → held', () => {
  const sup = { low: 22400, high: 22410 };
  const mins = [quiet(0, 22440), m(1, 22402, 22420, 900, 200), quiet(2, 22430)];
  const r = analyzeTest(sup, mins, [], 22430);
  assert.equal(r.role, 'support');
  assert.equal(r.status, 'held');
});

test('untouched zone → no test', () => {
  assert.equal(analyzeTest(zone, [quiet(0, 22500), quiet(1, 22505)], [], 22505), null);
});

test('support: 15-min close below with sellers → breakdown; recovery → failed breakdown', () => {
  const sup = { low: 22400, high: 22410 };
  const mins = [quiet(0, 22430)];
  for (let i = 1; i < 15; i++) mins.push(m(i, 22380, 22405, 300, 1200));
  // a close only 10 pts below support is not a breakdown yet (needs more than 15 pts)
  assert.equal(analyzeTest(sup, mins, [{ t: T0, close: 22390 }], 22390).status, 'testing');
  const bars = [{ t: T0, close: 22380 }];
  assert.equal(analyzeTest(sup, mins, bars, 22380).status, 'breakdown');
  mins.push(m(15, 22398, 22415, 900, 200));
  assert.equal(analyzeTest(sup, mins, bars, 22412).status, 'failed breakdown');
});

test('zones never chain wider than maxWidth', () => {
  const ev = [0, 10, 20, 30, 40, 50, 60].map((d, i) => ({ t: T0 + i, day: '2026-10-05', weight: 100, side: 'supply', kind: 'aggressive selling', price: 22800 + d }));
  const zones = buildZones(ev, { nowSec: T0 });
  assert.equal(zones.length, 2); // 22800–22830 and 22840–22860
  for (const z of zones) assert.ok(z.high - z.low <= 35, `zone ${z.low}-${z.high} too wide`);
});

test('statusHistory records when each status of the latest touch was given', () => {
  const sup = { low: 22400, high: 22410 };
  const mins = [quiet(0, 22430)];
  for (let i = 1; i < 4; i++) mins.push(m(i, 22398, 22412, 300, 900)); // in the zone, sellers pushing
  for (let i = 4; i < 8; i++) mins.push(m(i, 22425, 22440, 500, 400)); // bounced well above
  const h = statusHistory(sup, mins, [], {});
  assert.equal(h[0].status, 'testing');
  assert.equal(h.at(-1).status, 'absorbed');
  assert.equal(h.at(-1).at, mins[4].time);
});
