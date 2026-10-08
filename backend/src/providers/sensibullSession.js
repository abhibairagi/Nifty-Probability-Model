// Daily Sensibull session: the user pastes a "Copy as cURL" from the Sensibull dashboard once a day;
// only its cookies (with the access_token) are kept and reused for every request that day. The request body,
// expiry list and other headers in the curl are ignored.
//
// Secrets live ONLY in data/secrets/sensibull-session.json (git-ignored) and are never returned by the API.


import { parseCurlCommand, cookieNames, readSecret, writeSecret, removeSecret } from './curlSession.js';

export { tokenize } from './curlSession.js';

/** Parses a Sensibull curl: needs the logged-in cookies; the JSON body (if any) gives the expiry list. */
export function parseCurl(text) {
  const { url, headers, cookie, body } = parseCurlCommand(text);
  if (!cookie) throw new Error('no cookies found in the curl (expected a -b \'…\' or -H \'cookie: …\' part)');
  if (!/access_token=/.test(cookie)) throw new Error('cookies do not contain access_token — copy the curl while logged in to Sensibull');
  let json = null;
  if (body) {
    const end = body.lastIndexOf('}'); // tolerate stray characters after the JSON (e.g. a trailing "~")
    try {
      json = JSON.parse(body.slice(0, end + 1));
    } catch {
      json = null;
    }
  }
  return { url, headers, cookie, body: json };
}

function decodeJwtExp(cookie) {
  const m = cookie.match(/client_info=([^;]+)/);
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** Standard browser headers sent with every Sensibull request; nothing else is taken from the pasted curl. */
export const STD_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  origin: 'https://web.sensibull.com',
  referer: 'https://web.sensibull.com/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
};

/** Parses and saves the session: only the cookies (which carry access_token) are kept. Returns the public status. */
export function saveSessionFromCurl(text) {
  const { cookie } = parseCurl(text);
  const session = { savedAt: new Date().toISOString(), cookie, tokenExpiresAt: decodeJwtExp(cookie) };
  writeSecret('sensibull', session);
  lastResult = {};
  return sessionStatus();
}

export function loadSession() {
  return readSecret('sensibull');
}

export function clearSession() {
  removeSecret('sensibull');
  lastResult = {};
}

let lastResult = {}; // symbol → { ok, at, error?, … }
export function recordResult(r) {
  lastResult[r.symbol] = { ...r, at: new Date().toISOString() };
}

/** Everything the UI may see — no cookie or header values. */
export function sessionStatus() {
  const s = loadSession();
  if (!s) return { configured: false, lastResult };
  const expired = s.tokenExpiresAt ? new Date(s.tokenExpiresAt) < new Date() : false;
  return {
    configured: true,
    savedAt: s.savedAt,
    tokenExpiresAt: s.tokenExpiresAt,
    expired,
    cookieNames: cookieNames(s.cookie),
    lastResult,
  };
}
