import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl } from '../src/providers/sensibullSession.js';
import { normalizeSensibull, pickExpiries } from '../src/providers/sensibull.js';
import { normalizeSnapshot } from '../src/engine/snapshot.js';
import { analyze } from '../src/engine/index.js';

const CURL = `curl --url 'https://oxide.sensibull.com/v1/compute/1/oi_graphs/oi_chart' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'content-type: application/json' \\
  -b 'a=1; access_token=pb:FAKE; client_info=x.eyJleHAiOjE3OTEyNTExMDB9.y' \\
  -H 'x-device-id: dev-123' \\
  --data-raw '{"underlying":"NIFTY","date":"2026-10-05","expiries":{"2026-10-13":{"is_weekly":true,"is_enabled":false},"2026-10-06":{"is_weekly":true,"is_enabled":true}}}'~`;

test('parseCurl extracts cookie, headers and body (tolerates trailing ~)', () => {
  const p = parseCurl(CURL);
  assert.equal(p.url, 'https://oxide.sensibull.com/v1/compute/1/oi_graphs/oi_chart');
  assert.match(p.cookie, /access_token=pb:FAKE/);
  assert.equal(p.headers['x-device-id'], 'dev-123');
  assert.equal(p.body.underlying, 'NIFTY');
  assert.ok(p.body.expiries['2026-10-06'].is_enabled);
});

test('parseCurl rejects input without access_token', () => {
  assert.throws(() => parseCurl("curl 'https://x' -b 'a=1'"), /access_token/);
});

test('pickExpiries enables only the nearest expiry on/after today; month-end expiry is monthly', () => {
  const list = ['2026-10-13', '2026-10-06', '2026-09-29', '2026-10-27', '2026-11-03'];
  assert.deepEqual(pickExpiries('NIFTY', list, '2026-10-06'), { expiries: { '2026-10-06': { is_weekly: true, is_enabled: true } }, expiry: '2026-10-06' });
  assert.deepEqual(pickExpiries('NIFTY', list, '2026-10-21').expiries, { '2026-10-27': { is_weekly: false, is_enabled: true } });
});

test('normalizeSensibull maps oi_chart + oi_change into a snapshot the engine accepts', () => {
  const strikes = [22450, 22500, 22550, 22600, 22650];
  const chart = {
    success: true,
    payload: {
      input: { expiries: { '2026-10-06': { is_weekly: true, is_enabled: true } } },
      intraday_last_available_timestamp: '2026-10-05T08:27:00Z',
      current_ltp: 22553.35,
      prev_ltp: 22421.95,
      per_strike_data: Object.fromEntries(strikes.map((k, i) => [String(k), { call_oi: 1e6 * (i + 1), put_oi: 1e6 * (5 - i), prev_call_oi: 5e5, prev_put_oi: 5e5 }])),
    },
  };
  const change = { success: true, payload: { per_strike_data: { 22550: { call_oi_change: -520, put_oi_change: 88400 } } } };
  const snap = normalizeSnapshot(normalizeSensibull(chart, change, { symbol: 'NIFTY' }));
  assert.equal(snap.spot, 22553.35);
  assert.equal(snap.expiry, new Date('2026-10-06T15:30:00+05:30').toISOString());
  assert.equal(snap.strikes.find((s) => s.strike === 22550).pe.oiChange5m, 88400);
  const r = analyze([snap, snap], { atmIvOverride: 18 });
  assert.equal(r.market.ivSource, 'manual (settings)');
  assert.equal(r.market.atmIv, 18);
});
