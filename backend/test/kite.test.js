import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKiteCurl } from '../src/providers/kite.js';

const CURL = `curl --url 'https://kite.zerodha.com/oms/instruments/historical/264969/5minute?user_id=AB1234&oi=1&from=2026-09-24&to=2026-09-26' \\
  -H 'accept: */*' \\
  -H 'authorization: enctoken FAKE/TOKEN+abc==' \\
  -b 'kf_session=x; user_id=AB1234; enctoken=FAKE/TOKEN+abc==' \\
  -H 'user-agent: Mozilla/5.0'`;

test('parseKiteCurl extracts enctoken, user id and cookies', () => {
  const s = parseKiteCurl(CURL);
  assert.equal(s.userId, 'AB1234');
  assert.equal(s.headers.authorization, 'enctoken FAKE/TOKEN+abc==');
  assert.match(s.cookie, /kf_session=x/);
});

test('parseKiteCurl falls back to the enctoken cookie when the header is missing', () => {
  const s = parseKiteCurl(CURL.replace("-H 'authorization: enctoken FAKE/TOKEN+abc==' \\\n", ''));
  assert.equal(s.headers.authorization, 'enctoken FAKE/TOKEN+abc==');
});

test('parseKiteCurl rejects a curl without enctoken', () => {
  assert.throws(() => parseKiteCurl("curl 'https://kite.zerodha.com/oms/x' -b 'user_id=AB1234'"), /enctoken/);
});

test('parseKiteCurl rejects non-Kite URLs', () => {
  assert.throws(() => parseKiteCurl("curl 'https://example.com/x' -H 'authorization: enctoken a' -b 'user_id=A'"), /kite/);
});
