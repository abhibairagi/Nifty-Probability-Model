// INDstocks (INDmoney) live index prices over WebSocket — free with an INDstocks account.
//
//   wss://ws-prices.indstocks.com/api/v1/ws/prices      header  Authorization: <access token>
//   → send { action: "subscribe", mode: "ltp", instruments: ["NIDX:40000001", "BIDX:40000006"] }
//   ← { mode: "ltp", instrument: "40000001", timestamp: <ms>, data: { ltp } }   (NIFTY ≈ every 100 ms, SENSEX ≈ 1 s)
//
// Index ids come from GET https://api.indstocks.com/market/instruments?source=index (NIFTY 50 = 40000001,
// SENSEX = 40000006). The access token is generated daily on indstocks.com → API Trading → Access Tokens and pasted
// on the Data Sessions page (valid ~24 h); IND_MONEY in backend/.env is used while it is unexpired if nothing valid
// was pasted. Display only: the model keeps using Kite's 1-minute spot, which is taken
// at the same minute as the option premiums.

import { readSecret, writeSecret, removeSecret } from './curlSession.js';

const WS_URL = 'wss://ws-prices.indstocks.com/api/v1/ws/prices';
const API = 'https://api.indstocks.com';
export const INDSTOCKS_INDEX = { NIFTY: { scrip: 'NIDX:40000001', id: '40000001' }, SENSEX: { scrip: 'BIDX:40000006', id: '40000006' } };

const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const valid = (s) => s?.token && (!s.tokenExpiresAt || new Date(s.tokenExpiresAt) > new Date());

/** The token pasted on Data Sessions; else IND_MONEY from .env while it is unexpired. */
export function loadIndSession() {
  const stored = readSecret('indstocks');
  if (valid(stored)) return stored;
  const env = process.env.IND_MONEY?.trim();
  if (env) {
    const fromEnv = { savedAt: null, token: env, tokenExpiresAt: jwtExp(env), source: 'env' };
    if (valid(fromEnv)) return fromEnv;
  }
  return stored;
}


/** Accepts the bare token, "Bearer <token>" or a pasted curl containing an Authorization header. */
export function parseToken(text = '') {
  const t = String(text).trim();
  const fromHeader = t.match(/authorization:\s*(?:bearer\s+)?([A-Za-z0-9_\-.]+)/i)?.[1];
  const token = fromHeader ?? t.replace(/^bearer\s+/i, '');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('that does not look like an INDstocks access token (eyJ…)');
  return token;
}

/** Checks the token with a small REST call before storing it. */
export async function saveIndToken(text) {
  const token = parseToken(text);
  const res = await fetch(`${API}/market/instruments?source=index`, { headers: { Authorization: token }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`INDstocks rejected the token (HTTP ${res.status})`);
  writeSecret('indstocks', { savedAt: new Date().toISOString(), token, tokenExpiresAt: jwtExp(token), source: 'pasted' });
  return true;
}

export const clearIndSession = () => removeSecret('indstocks');

/**
 * Keeps one WebSocket open while a valid token is stored, subscribed to the enabled indices, and remembers the latest
 * tick (plus high/low/first tick since the feed connected today) per symbol. Reconnects with backoff; re-checks the stored token every 30 s.
 */
export function createIndFeed(symbols = ['NIFTY'], { log = console } = {}) {
  const wanted = symbols.filter((s) => INDSTOCKS_INDEX[s]);
  const bySecId = Object.fromEntries(wanted.map((s) => [INDSTOCKS_INDEX[s].id, s]));
  const latest = {}; // symbol → { ltp, at, day, open, high, low, ticks }
  let ws = null;
  let token = null;
  let state = { connected: false, error: null, since: null };
  let backoff = 1000;
  let retryTimer = null;

  function onTick(msg) {
    const sym = bySecId[String(msg.instrument)];
    const ltp = msg.data?.ltp;
    if (!sym || !(ltp > 0)) return;
    const at = msg.timestamp ?? Date.now();
    const day = istDate(at);
    const prev = latest[sym]?.day === day ? latest[sym] : null;
    latest[sym] = {
      ltp,
      at,
      day,
      open: prev?.open ?? ltp,
      high: Math.max(prev?.high ?? ltp, ltp),
      low: Math.min(prev?.low ?? ltp, ltp),
      ticks: (prev?.ticks ?? 0) + 1,
    };
  }

  function connect() {
    clearTimeout(retryTimer);
    const s = loadIndSession();
    const expired = s?.tokenExpiresAt && new Date(s.tokenExpiresAt) < new Date();
    if (!s || expired || !wanted.length) {
      token = null;
      state = { connected: false, error: s && expired ? 'token expired — paste today’s INDstocks token' : null, since: null };
      return;
    }
    token = s.token;
    try {
      ws = new WebSocket(WS_URL, { headers: { Authorization: token } });
    } catch (e) {
      state = { connected: false, error: e.message, since: null };
      return schedule();
    }
    const sock = ws;
    sock.onopen = () => {
      backoff = 1000;
      state = { connected: true, error: null, since: new Date().toISOString() };
      sock.send(JSON.stringify({ action: 'subscribe', mode: 'ltp', instruments: wanted.map((x) => INDSTOCKS_INDEX[x].scrip) }));
      log.info?.(`[indstocks] live feed connected (${wanted.join(', ')})`);
    };
    sock.onmessage = async (e) => {
      try {
        const text = typeof e.data === 'string' ? e.data : Buffer.from(await e.data.arrayBuffer()).toString('utf8');
        let msg = JSON.parse(text);
        if (typeof msg === 'string') msg = JSON.parse(msg); // ticks arrive JSON-encoded twice: "{\"mode\":…}"
        onTick(msg);
      } catch {}
    };
    sock.onerror = (e) => {
      state = { ...state, error: e?.message || 'connection error' };
    };
    sock.onclose = (e) => {
      if (ws !== sock) return; // replaced on purpose
      state = { connected: false, error: state.error ?? (e.code !== 1000 ? `closed (${e.code})` : null), since: null };
      ws = null;
      schedule();
    };
  }

  function schedule() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }

  /** Reconnect with the newly stored token (or disconnect if it was removed). */
  function restart() {
    const old = ws;
    ws = null;
    try {
      old?.close();
    } catch {}
    backoff = 1000;
    connect();
  }

  // pick up a pasted / expired token without a restart
  setInterval(() => {
    const s = loadIndSession();
    if ((s?.token ?? null) !== token || (s?.tokenExpiresAt && new Date(s.tokenExpiresAt) < new Date() && ws)) restart();
  }, 30_000).unref();

  connect();

  return {
    restart,
    live: (symbol) => {
      const l = latest[symbol];
      return l ? { symbol, source: 'indstocks', ...l, ageMs: Date.now() - l.at, connected: state.connected } : { symbol, source: 'indstocks', ltp: null, connected: state.connected };
    },
    status: () => {
      const s = loadIndSession();
      const expired = s?.tokenExpiresAt ? new Date(s.tokenExpiresAt) < new Date() : false;
      const feed = { ...state, symbols: wanted, last: Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, { ltp: v.ltp, at: new Date(v.at).toISOString(), ticks: v.ticks }])) };
      return s ? { configured: true, savedAt: s.savedAt, tokenExpiresAt: s.tokenExpiresAt, expired, source: s.source ?? 'pasted', feed } : { configured: false, feed };
    },
  };
}
