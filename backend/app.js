// Expiry-day probability model — HTTP API (the Next.js dashboard in ../frontend proxies /api/* here). No external dependencies.
// Every endpoint takes ?symbol=NIFTY|SENSEX (default NIFTY) and most take ?date=YYYY-MM-DD (default: today IST).
//
//   GET  /api/instruments                supported instruments + whether each is being polled
//   GET  /api/analysis                   latest full report
//   GET  /api/timeline                   bias/levels timeline for the day
//   GET  /api/oi/series                  per-strike OI through the day + fresh-OI / wall presets (Multi-strike OI)
//   GET  /api/snapshots                  raw stored snapshots
//   GET  /api/prices                     the day's 1-minute price series (spot, forward, VIX, future, strike premiums/IV)
//   GET  /api/dates                      sessions with stored data
//   GET  /api/status                     provider / market status
//   POST /api/snapshot                   push a normalized snapshot manually (JSON body; its "symbol" field picks the instrument)
//   POST /api/poll                       fetch from the provider right now (ignores market hours)
//   GET  /api/config  POST /api/config   model config (S/R zones, weights, target probability, ATM IV override)
//   GET  /api/sensibull/session          session status (never returns secrets)
//   POST /api/sensibull/session          { curl } — paste the day's "Copy as cURL" from Sensibull
//   DELETE /api/sensibull/session        forget the stored session
//   GET  /api/sensibull/iv?date=         Sensibull live ATM IV / IVP / straddle / max pain for the current expiry
//   GET|POST|DELETE /api/kite/session    same for the Kite (Zerodha) session — India VIX, spot, premiums
//   GET|POST|DELETE /api/dhan/session    same for the Dhan session — futures order flow (?symbol=NIFTY|SENSEX, one session each)
//   GET  /api/orderflow?date=            a day's 1-minute order-flow candles (past days downloaded from Dhan on demand;
//                                        only the last 30 days)
//   GET  /api/orderflow/dates            days stored for the current contract
//   GET  /api/orderflow/zones?date=      15-min supply/demand zones as of that day + read of that day's zone tests
//   (Order Flow tab only — none of it is used by the model)
//   GET  /api/live                       latest INDstocks tick for the symbol (display only — the model uses Kite's 1-min spot)
//   GET|POST|DELETE /api/indstocks/session   INDstocks access token ({ token }) for the live index feed

import http from 'node:http';
import * as store from './src/store.js';
import { getReport, ingest, startPoller, startPriceTicker, isMarketOpen, reanalyze, enrichStoredDay, analyzeDate, oiSeries } from './src/service.js';
import { createMockProvider } from './src/providers/mock.js';
import { createSensibullProvider } from './src/providers/sensibull.js';
import { DEFAULT_CONFIG } from './src/engine/index.js';
import { INSTRUMENTS, DEFAULT_SYMBOL, getInstrument } from './src/instruments.js';
import { saveSessionFromCurl, sessionStatus, clearSession } from './src/providers/sensibullSession.js';
import { saveKiteSessionFromCurl, kiteStatus, clearKiteSession, createVixSource, createCandleCache } from './src/providers/kite.js';
import { scheduleInstruments, instrumentsStatus, bfoInstrumentsStatus } from './src/providers/kiteInstruments.js';
import { createPremiumEnricher } from './src/providers/kitePremiums.js';
import {
  saveDhanSessionFromCurl,
  dhanStatus,
  clearDhanSession,
  getOrderFlowDay,
  ensureOrderFlowDay,
  storedOrderFlowDates,
  startOrderFlowPoller,
  backfillOrderFlowHistory,
} from './src/providers/dhan.js';
import { orderFlowZones } from './src/orderflow/service.js';
import { createIntradayPoller, getIntradayDay, intradayStatus } from './src/providers/sensibullIntraday.js';
import { createIndFeed, saveIndToken, clearIndSession } from './src/providers/indstocks.js';

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1'; // local only — the session endpoint handles live credentials
const PROVIDER = process.env.PROVIDER || 'sensibull';
const POLL_MINUTES = Number(process.env.POLL_MINUTES) || 3; // OI (Sensibull)
const PRICE_SECONDS = Number(process.env.PRICE_SECONDS) || 60; // spot + premiums (Kite)
const FORCE = process.env.FORCE_MARKET_OPEN === '1';
const ORDERFLOW_LOOKBACK_DAYS = 30; // the Order Flow calendar covers today and the previous 30 days

/** Order Flow tab dates: YYYY-MM-DD within the last ORDERFLOW_LOOKBACK_DAYS, else an error. */
function orderFlowDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const today = store.istDate();
  const earliest = store.istDate(Date.now() - ORDERFLOW_LOOKBACK_DAYS * 86400e3);
  if (date > today || date < earliest) throw new Error(`order flow is available for ${earliest} to ${today} only`);
  return date;
}

const SYMBOLS = (process.env.SYMBOLS || 'NIFTY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10e6) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

// With a Kite session, every snapshot gets (at its own minute): India VIX, each strike's premium + implied vol,
// and the near-month future. Instrument tokens come from the NFO dump downloaded each morning (Mon–Thu).
// SENSEX uses the BFO dump, the BSE SENSEX index and its own enricher; NIFTY's path is unchanged.
const instrumentsReady = scheduleInstruments({ bfo: SYMBOLS.includes('SENSEX') });
const candles = createCandleCache();
const vix = createVixSource(candles);
const premiums = createPremiumEnricher(candles);
const sensexPremiums = SYMBOLS.includes('SENSEX') ? createPremiumEnricher(candles, { name: 'SENSEX' }) : null;
async function enrich(raw) {
  await instrumentsReady;
  if (!(raw.vix > 0)) raw.vix = await vix.at(new Date(raw.timestamp).getTime());
  if (raw.symbol === 'SENSEX') return sensexPremiums ? sensexPremiums.enrich(raw) : raw;
  return premiums.enrich(raw);
}

// on startup, fill VIX/premiums into any of today's readings that lack them (e.g. taken before the Kite session was pasted)
for (const s of SYMBOLS) enrichStoredDay(s, store.istDate(), enrich).catch((e) => console.error(`[kite] ${e.message}`));

// Dhan order flow: its own 1-minute poller and storage. Shown on the Order Flow tab only — never fed into the model.
const orderFlow = startOrderFlowPoller('NIFTY', { seconds: 60, isMarketOpen, force: FORCE });
backfillOrderFlowHistory('NIFTY').catch((e) => console.error(`[orderflow history] ${e.message}`)); // past days for zones
// SENSEX futures order flow: its own Dhan session (pasted on Data Sessions with SENSEX selected), poller and storage
const orderFlowSensex = SYMBOLS.includes('SENSEX') ? startOrderFlowPoller('SENSEX', { seconds: 60, isMarketOpen, force: FORCE }) : null;
if (orderFlowSensex) backfillOrderFlowHistory('SENSEX').catch((e) => console.error(`[orderflow history SENSEX] ${e.message}`));

// Sensibull live ATM IV / IVP / straddle / max pain for the current expiry, every minute (feeds the model's ATM IV)
const sbIntraday = SYMBOLS.includes('NIFTY')
  ? createIntradayPoller('NIFTY', { seconds: 60, isMarketOpen, force: FORCE, onUpdate: (date) => analyzeDate('NIFTY', date) })
  : null;
const sbIntradaySensex = SYMBOLS.includes('SENSEX')
  ? createIntradayPoller('SENSEX', { seconds: 60, isMarketOpen, force: FORCE, onUpdate: (date) => analyzeDate('SENSEX', date) })
  : null;

// INDstocks WebSocket: live NIFTY / SENSEX index ticks for display (sidebar). Not fed into the model.
const indFeed = createIndFeed(SYMBOLS);

const pollers = new Map(); // symbol → poller
if (PROVIDER !== 'none') {
  for (const symbol of SYMBOLS) {
    try {
      getInstrument(symbol);
      const provider = PROVIDER === 'sensibull' ? createSensibullProvider(symbol) : createMockProvider(symbol);
      pollers.set(symbol, startPoller(provider, { minutes: POLL_MINUTES, force: FORCE, enrich }));
      startPriceTicker(symbol, enrich, { seconds: PRICE_SECONDS, force: FORCE });
      console.log(`[app] ${symbol}: OI from ${provider.name} every ${POLL_MINUTES} min, prices from Kite every ${PRICE_SECONDS} s${FORCE ? ' (forced, ignoring market hours)' : ' during 09:15–15:30 IST'}`);
    } catch (e) {
      console.error(`[app] ${symbol}: provider "${PROVIDER}" not started: ${e.message}`);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || store.istDate();
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,DELETE' });
      return res.end();
    }
    const symbol = getInstrument(url.searchParams.get('symbol') || DEFAULT_SYMBOL).symbol;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/instruments':
        return send(res, 200, Object.values(INSTRUMENTS).map(({ mock, ...i }) => ({ ...i, enabled: SYMBOLS.includes(i.symbol), polling: pollers.has(i.symbol) })));
      case 'GET /api/analysis': {
        const report = getReport(symbol, date);
        return report ? send(res, 200, report) : send(res, 404, { error: `no ${symbol} snapshots for ${date}` });
      }
      case 'GET /api/oi/series': {
        const series = oiSeries(symbol, date);
        return series ? send(res, 200, series) : send(res, 404, { error: `no ${symbol} snapshots for ${date}` });
      }
      case 'GET /api/timeline':
        return send(res, 200, store.getReports(symbol, date));
      case 'GET /api/snapshots':
        return send(res, 200, store.getSnapshots(symbol, date));
      case 'GET /api/prices':
        return send(res, 200, store.getLive(symbol, date));
      case 'GET /api/orderflow/zones':
        return send(res, 200, await orderFlowZones(symbol, { date: orderFlowDate(date) }));
      case 'GET /api/orderflow/dates':
        return send(res, 200, {
          today: store.istDate(),
          earliest: store.istDate(Date.now() - ORDERFLOW_LOOKBACK_DAYS * 86400e3),
          stored: storedOrderFlowDates(symbol),
        });
      case 'GET /api/orderflow':
        orderFlowDate(date);
        return send(res, 200, (await ensureOrderFlowDay(symbol, date)) ?? getOrderFlowDay(symbol, date) ?? { date, candles: [] });
      case 'GET /api/dates':
        return send(res, 200, store.listDates(symbol));
      case 'GET /api/status':
        return send(res, 200, { provider: PROVIDER, symbol, polling: pollers.has(symbol), pollMinutes: POLL_MINUTES, priceSeconds: PRICE_SECONDS, marketOpen: isMarketOpen(), forced: FORCE, today: store.istDate() });
      case 'POST /api/snapshot':
        return send(res, 200, ingest(await readBody(req)));
      case 'POST /api/poll': {
        const poller = pollers.get(symbol);
        if (!poller) return send(res, 400, { error: `no provider running for ${symbol}` });
        await poller.runNow({ force: true });
        return send(res, 200, getReport(symbol) ?? { ok: true });
      }
      case 'GET /api/config':
        return send(res, 200, { ...DEFAULT_CONFIG, ...store.getConfig(symbol) });
      case 'POST /api/config': {
        const cfg = store.saveConfig(symbol, { ...store.getConfig(symbol), ...(await readBody(req)) });
        reanalyze(symbol);
        return send(res, 200, cfg);
      }
      case 'GET /api/sensibull/session':
        return send(res, 200, { ...sessionStatus(), intraday: intradayStatus(), intradaySensex: sbIntradaySensex ? intradayStatus('SENSEX') : undefined });
      case 'GET /api/sensibull/iv':
        return send(res, 200, getIntradayDay(symbol, date) ?? { date, bars: [], live: [] });
      case 'POST /api/sensibull/session': {
        const status = saveSessionFromCurl((await readBody(req)).curl);
        sbIntraday?.tickNow({ force: true });
        sbIntradaySensex?.tickNow({ force: true });
        for (const p of pollers.values()) {
          p.resetBackfill();
          p.runNow({ force: true }); // backfill (if needed) and fetch immediately with the new session
        }
        return send(res, 200, status);
      }
      case 'DELETE /api/sensibull/session':
        clearSession();
        return send(res, 200, sessionStatus());
      case 'GET /api/kite/session':
        return send(res, 200, {
          ...kiteStatus(),
          premiums: premiums.status(),
          instruments: instrumentsStatus(),
          ...(sensexPremiums ? { sensexPremiums: sensexPremiums.status(), bfoInstruments: bfoInstrumentsStatus() } : {}),
        });
      case 'POST /api/kite/session': {
        const status = await saveKiteSessionFromCurl((await readBody(req)).curl);
        candles.reset();
        // fill VIX + premiums into today's already-stored readings, in the background
        for (const s of SYMBOLS) enrichStoredDay(s, store.istDate(), enrich).catch((e) => console.error(`[kite] ${e.message}`));
        return send(res, 200, status);
      }
      case 'GET /api/live':
        return send(res, 200, indFeed.live(symbol));
      case 'GET /api/indstocks/session':
        return send(res, 200, indFeed.status());
      case 'POST /api/indstocks/session': {
        const body = await readBody(req);
        await saveIndToken(body.token ?? body.curl);
        indFeed.restart();
        return send(res, 200, indFeed.status());
      }
      case 'DELETE /api/indstocks/session':
        clearIndSession();
        indFeed.restart();
        return send(res, 200, indFeed.status());
      case 'GET /api/dhan/session':
        return send(res, 200, dhanStatus(symbol));
      case 'POST /api/dhan/session': {
        const status = await saveDhanSessionFromCurl((await readBody(req)).curl, symbol);
        const poller = symbol === 'SENSEX' ? orderFlowSensex : orderFlow;
        poller?.tickNow({ force: true }).catch(() => {}); // pull today's data right away
        backfillOrderFlowHistory(symbol).catch(() => {}); // and past days for the zones
        return send(res, 200, status);
      }
      case 'DELETE /api/dhan/session':
        clearDhanSession(symbol);
        return send(res, 200, dhanStatus(symbol));
      case 'DELETE /api/kite/session':
        clearKiteSession();
        return send(res, 200, kiteStatus());
      default:
        return send(res, 404, { error: 'not found' });
    }
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`[app] API → http://${HOST}:${PORT}/api  (dashboard: cd ../frontend && npm run dev)`));
