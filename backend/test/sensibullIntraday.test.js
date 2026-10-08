import test from 'node:test';
import assert from 'node:assert/strict';
import { currentExpiry, buildBody, parseIntraday } from '../src/providers/sensibullIntraday.js';
import { analyze } from '../src/engine/index.js';
import { createMockMarket } from '../src/providers/mock.js';

const EXP = ['2026-11-23', '2026-10-13', '2026-10-06', '2026-10-27'];
const at = (s) => new Date(s).getTime();

test('current expiry = nearest on/after today; rolls to the next after 15:30 on expiry day', () => {
  assert.equal(currentExpiry(EXP, at('2026-10-05T12:00:00+05:30')), '2026-10-06');
  assert.equal(currentExpiry(EXP, at('2026-10-06T15:00:00+05:30')), '2026-10-06');
  assert.equal(currentExpiry(EXP, at('2026-10-06T15:45:00+05:30')), '2026-10-13');
});

test('request enables only the current expiry', () => {
  const b = buildBody('2026-10-06', 22550);
  for (const k of ['iv', 'ivp', 'rolling_atm_straddle', 'pcr', 'max_pain']) assert.deepEqual(b[k].expiries, { '2026-10-06': { enabled: true } });
  assert.equal(b.iv.automatic_expiry, false);
  assert.deepEqual(b.client_atm_strikes_map, { '2026-10-06': 22550 });
});

test("parseIntraday keeps only the day's market-hours bars for the current expiry", () => {
  const bar = (iv) => ({
    spot: 22555,
    iv: { atm_iv: iv, atm_strike: 22550 },
    ivp: { ivp: 80 },
    indiavix: { indiavix_price: 14.7 },
    pcr_data: { pcr: 0.9 },
    max_pain_data: { max_pain: 22550 },
    rolling_atm_straddle: { '2026-10-06': { atm_strike: 22550, ltp: 152.6 }, '2026-10-13': { atm_strike: 22550, ltp: 400 } },
  });
  const payload = {
    chart_data: {
      '2026-10-02T15:15:00+05:30': bar(12),
      '2026-10-05T15:15:00+05:30': bar(16.67),
      '2026-10-05T15:30:00+05:30': bar(16.22),
      '2026-10-05T19:30:00+05:30': bar(17.28), // after hours — dropped
    },
  };
  const rows = parseIntraday(payload, '2026-10-06', '2026-10-05');
  assert.deepEqual(rows.map((r) => r.bar), ['15:15', '15:30']);
  assert.equal(rows.at(-1).atmIv, 16.22);
  assert.equal(rows.at(-1).straddle, 152.6); // the current expiry's straddle, not the next one's
});

test('model uses Sensibull ATM IV only when fresh and for the same expiry', () => {
  const expiry = '2026-10-06T15:30:00+05:30';
  const m = createMockMarket({ seed: 5, expiry });
  const snaps = Array.from({ length: 6 }, (_, i) => m.tick(at('2026-10-06T09:15:00+05:30') + i * 180_000));
  const last = snaps.at(-1).timestamp;
  const sb = { polledAt: last, expiry: '2026-10-06', atmIv: 31.5, ivp: 80, maxPain: 22500, straddle: 150 };
  const r = analyze(snaps, {}, null, null, sb);
  assert.equal(r.market.atmIv, 31.5);
  assert.equal(r.market.ivSource, 'Sensibull live ATM IV');
  assert.equal(r.market.ivp, 80);
  const stale = analyze(snaps, {}, null, null, { ...sb, polledAt: new Date(at(last) - 3600e3).toISOString() });
  assert.notEqual(stale.market.atmIv, 31.5);
  const otherExpiry = analyze(snaps, {}, null, null, { ...sb, expiry: '2026-10-13' });
  assert.notEqual(otherExpiry.market.atmIv, 31.5);
});
