import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, expectedMove, probOtm, yearsToExpiry } from '../src/engine/math.js';
import { classifyLeg, ACTIONS } from '../src/engine/oiAnalyzer.js';
import { flowScore, labelFor } from '../src/engine/direction.js';
import { analyze } from '../src/engine/index.js';
import { createMockMarket } from '../src/providers/mock.js';

test('normCdf matches known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
});

test('expected move reproduces the worked example (22450, IV 20.4, 1.104 days ≈ ±252)', () => {
  assert.equal(Math.round(expectedMove(22450, 20.4, 1.104 / 365)), 252);
});

test('expected move at 1 PM on expiry with IV 40 ≈ ±152', () => {
  const years = yearsToExpiry('2026-10-06T15:30:00+05:30', new Date('2026-10-06T13:00:00+05:30').getTime());
  assert.equal(Math.round(expectedMove(22450, 40, years)), 152);
});

test('ATM probability OTM ≈ 50%, far OTM ≈ 100%', () => {
  const y = 1 / 365;
  assert.ok(Math.abs(probOtm('CE', 22450, 22450, 20, y) - 0.5) < 0.01);
  assert.ok(probOtm('CE', 22450, 23000, 20, y) > 0.98);
  assert.ok(probOtm('PE', 22450, 21900, 20, y) > 0.98);
});

test('OI classification', () => {
  const p = { oi: 1_000_000, ltp: 50 };
  assert.equal(classifyLeg(p, { oi: 1_100_000, ltp: 45 }).action, ACTIONS.WRITING);
  assert.equal(classifyLeg(p, { oi: 1_100_000, ltp: 55 }).action, ACTIONS.LONG_BUILDUP);
  assert.equal(classifyLeg(p, { oi: 900_000, ltp: 55 }).action, ACTIONS.SHORT_COVERING);
  assert.equal(classifyLeg(p, { oi: 900_000, ltp: 45 }).action, ACTIONS.LONG_UNWINDING);
  assert.equal(classifyLeg(p, { oi: 1_001_000, ltp: 45 }).action, ACTIONS.NONE);
});

test('put writing + call covering reads bullish, the reverse bearish', () => {
  const leg = (action, dOi) => ({ action, dOi });
  const bull = [{ strike: 22400, pe: leg(ACTIONS.WRITING, 500_000), ce: leg(ACTIONS.SHORT_COVERING, -300_000) }];
  const bear = [{ strike: 22500, pe: leg(ACTIONS.SHORT_COVERING, -300_000), ce: leg(ACTIONS.WRITING, 500_000) }];
  assert.ok(flowScore(bull, 22450, 150) > 0.9);
  assert.ok(flowScore(bear, 22450, 150) < -0.9);
});

test('labels', () => {
  assert.equal(labelFor(5), 'Sideways');
  assert.equal(labelFor(18), 'Sideways to Bullish');
  assert.equal(labelFor(-30), 'Mild Bearish');
  assert.equal(labelFor(60), 'Bullish');
});

test('full analysis runs on a simulated session', () => {
  const expiry = '2026-10-06T15:30:00+05:30';
  const m = createMockMarket({ seed: 7, expiry });
  const snaps = [];
  for (let i = 0; i < 20; i++) snaps.push(m.tick(new Date('2026-10-06T09:15:00+05:30').getTime() + i * 180_000));
  const r = analyze(snaps);
  const p = r.bias.probabilities;
  assert.ok(Math.abs(p.bullish + p.neutral + p.bearish - 100) <= 1);
  assert.ok(r.expectedRange.lower1 < r.market.spot && r.market.spot < r.expectedRange.upper1);
  assert.ok(r.strikes.ce.every((s) => s.strike >= r.market.spot));
  assert.ok(r.strikes.pe.every((s) => s.strike <= r.market.spot));
});

test('put gaining value only because spot fell is not "long buildup"', async () => {
  const { analyzeInterval } = await import('../src/engine/oiAnalyzer.js');
  const { bsPrice } = await import('../src/engine/math.js');
  const expiry = '2026-10-06T15:30:00+05:30';
  const t0 = '2026-10-06T11:00:00+05:30';
  const t1 = '2026-10-06T11:03:00+05:30';
  const y = (t) => (new Date(expiry) - new Date(t)) / (365 * 24 * 3600e3);
  const leg = (spot, t, oi, bump = 0) => ({ oi, iv: 15, ltp: bsPrice('PE', spot, 22400, 15, y(t)) + bump });
  const mk = (t, spot, pe) => ({ timestamp: t, expiry, spot, strikes: [{ strike: 22400, ce: { oi: 1e6, ltp: 10, iv: 15 }, pe }] });
  // spot falls 40 pts, put OI rises, premium rises slightly LESS than the model says → writers
  const rows = analyzeInterval(mk(t0, 22450, leg(22450, t0, 5e6)), mk(t1, 22410, leg(22410, t1, 5.5e6, -0.5)));
  assert.equal(rows[0].pe.action, ACTIONS.WRITING);
  assert.ok(rows[0].pe.dLtp > 0); // raw premium did go up
});

test('SENSEX: weekly expiry on Thursday, 100-pt strikes, analysis runs', async () => {
  const { nextExpiry } = await import('../src/instruments.js');
  const exp = nextExpiry('SENSEX', new Date('2026-10-05T12:00:00+05:30').getTime());
  assert.equal(exp, new Date('2026-10-08T15:30:00+05:30').toISOString());
  assert.equal(nextExpiry('NIFTY', new Date('2026-10-05T12:00:00+05:30').getTime()), new Date('2026-10-06T15:30:00+05:30').toISOString());
  const m = createMockMarket({ symbol: 'SENSEX', seed: 3, expiry: exp });
  const snaps = [];
  for (let i = 0; i < 15; i++) snaps.push(m.tick(new Date('2026-10-08T09:15:00+05:30').getTime() + i * 180_000));
  const r = analyze(snaps);
  assert.equal(r.symbol, 'SENSEX');
  assert.equal(r.market.step, 100);
  assert.ok(r.expectedRange.move1 > 0);
});

test('missing numeric fields stay null (not 0)', async () => {
  const { normalizeSnapshot } = await import('../src/engine/snapshot.js');
  const leg = { oi: 1, ltp: null };
  const s = normalizeSnapshot({ spot: 100, expiry: '2026-10-06T15:30:00+05:30', vix: null, strikes: [1, 2, 3].map((k) => ({ strike: k, ce: leg, pe: leg })) });
  assert.equal(s.vix, null);
  assert.equal(s.strikes[0].ce.ltp, null);
});

test('impliedVol inverts bsPrice', async () => {
  const { impliedVol, bsPrice } = await import('../src/engine/math.js');
  const y = 1 / 365;
  const p = bsPrice('CE', 22500, 22600, 17.3, y);
  assert.ok(Math.abs(impliedVol('CE', 22500, 22600, y, p) - 17.3) < 0.01);
  assert.equal(impliedVol('PE', 22500, 21000, y, 0.05), null); // no time value → null
});

test('small premium drift does not turn a large OI build into long buildup', () => {
  const p = { oi: 5_000_000, ltp: 64 };
  assert.equal(classifyLeg(p, { oi: 20_000_000, ltp: 67 }).action, ACTIONS.WRITING); // +4.7% premium: weak evidence
  assert.equal(classifyLeg(p, { oi: 20_000_000, ltp: 72 }).action, ACTIONS.LONG_BUILDUP); // +12.5%: buyers
});

test('baseAt picks the reading N clock-minutes back, whatever the polling rate', async () => {
  const { baseAt } = await import('../src/engine/direction.js');
  const at = (hhmm) => ({ timestamp: `2026-10-07T${hhmm}:00+05:30` });
  const oneMin = ['10:00', '10:01', '10:02', '10:03', '10:04', '10:05', '10:06', '10:07', '10:08', '10:09', '10:10'].map(at);
  assert.equal(baseAt(oneMin, 9).timestamp, at('10:01').timestamp);
  const gappy = ['10:00', '10:03', '10:16', '10:17'].map(at); // feed skipped 10:03 → 10:16
  assert.equal(baseAt(gappy, 9).timestamp, at('10:03').timestamp);
  assert.equal(baseAt([at('10:00'), at('10:02')], 9).timestamp, at('10:00').timestamp); // young session → first reading
});
