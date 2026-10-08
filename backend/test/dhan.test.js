import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDhanCurl } from '../src/providers/dhan.js';

// fake JWT whose payload is {"exp":1791270716}
const JWT = `x.${Buffer.from('{"exp":1791270716}').toString('base64url')}.y`;
const CURL = `curl --url 'https://ticks.dhan.co/orderflow/getOrderFlow' \\
  -H 'Accept: application/json' \\
  -H 'Auth: ${JWT}' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{"EXCH":"NSE","SEG":"D","SEC_ID":61471,"START":1,"END":2}'`;

test('parseDhanCurl extracts Auth token, contract and token expiry', () => {
  const s = parseDhanCurl(CURL);
  assert.equal(s.auth, JWT);
  assert.equal(s.secId, 61471);
  assert.equal(s.exch, 'NSE');
  assert.equal(s.tokenExpiresAt, new Date(1791270716 * 1000).toISOString());
  assert.equal(s.headers.auth, undefined); // token kept separately, not duplicated in headers
});

test('parseDhanCurl rejects a curl without Auth or SEC_ID', () => {
  assert.throws(() => parseDhanCurl(CURL.replace(/-H 'Auth: [^']+' \\\n/, '')), /Auth/);
  assert.throws(() => parseDhanCurl(CURL.replace('"SEC_ID":61471,', '')), /SEC_ID/);
});
