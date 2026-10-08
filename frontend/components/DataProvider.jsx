'use client';

// Shared state for every page: selected instrument + session, latest report, bias timeline, backend status.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, postJson } from '@/lib/api';

const REFRESH_MS = 20_000; // prices update every minute on the backend
const SYMBOL_KEY = 'expiry-model:symbol';
const DataContext = createContext(null);

function initialSymbol() {
  const fromUrl = new URLSearchParams(window.location.search).get('symbol');
  if (fromUrl) return fromUrl.toUpperCase();
  try {
    return localStorage.getItem(SYMBOL_KEY) || 'NIFTY';
  } catch {
    return 'NIFTY';
  }
}

export function DataProvider({ children }) {
  const [instruments, setInstruments] = useState([]);
  const [symbol, setSymbolState] = useState(null);
  const [status, setStatus] = useState(null);
  const [dates, setDates] = useState([]);
  const [date, setDate] = useState(null);
  const [report, setReport] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | empty | offline

  /** Builds an API path carrying the current instrument (and session when asked). */
  const q = useCallback(
    (path, { withDate = false, params = {} } = {}) => {
      const sp = new URLSearchParams({ symbol: symbol ?? 'NIFTY', ...(withDate && date ? { date } : {}), ...params });
      return `${path}?${sp}`;
    },
    [symbol, date],
  );

  const setSymbol = useCallback((s) => {
    try {
      localStorage.setItem(SYMBOL_KEY, s);
    } catch {}
    setSymbolState(s);
    setDate(null); // pick the default session for the new instrument
    setReport(null);
    setState('loading');
  }, []);

  useEffect(() => {
    const wanted = initialSymbol();
    setSymbolState(wanted);
    api('/api/instruments')
      .then((list) => {
        setInstruments(list);
        const enabled = list.filter((i) => i.enabled);
        // a remembered instrument that is no longer enabled falls back to the first enabled one
        if (enabled.length && !enabled.some((i) => i.symbol === wanted)) setSymbolState(enabled[0].symbol);
      })
      .catch(() => setState('offline'));
  }, []);

  const loadMeta = useCallback(async () => {
    if (!symbol) return;
    try {
      const [d, s] = await Promise.all([api(`/api/dates?symbol=${symbol}`), api(`/api/status?symbol=${symbol}`)]);
      setStatus(s);
      setDates([...new Set([s.today, ...d])].sort().reverse());
      // ?session=<date|sim> in the URL picks the session on first load
      setDate((cur) => cur ?? new URLSearchParams(window.location.search).get('session') ?? s.today);
    } catch {
      setState('offline');
    }
  }, [symbol]);

  const refresh = useCallback(async () => {
    if (!symbol || !date) return;
    try {
      const [r, t] = await Promise.all([api(q('/api/analysis', { withDate: true })), api(q('/api/timeline', { withDate: true }))]);
      setReport(r);
      setTimeline(t);
      setState('ready');
    } catch (e) {
      setReport(null);
      setTimeline([]);
      setState(e.status === 404 ? 'empty' : 'offline');
    }
  }, [symbol, date, q]);

  const pollNow = useCallback(async () => {
    await postJson(q('/api/poll'));
    await loadMeta();
    await refresh();
  }, [q, loadMeta, refresh]);

  useEffect(() => {
    loadMeta();
    const id = setInterval(loadMeta, 5 * 60_000);
    return () => clearInterval(id);
  }, [loadMeta]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <DataContext.Provider value={{ instruments, symbol, setSymbol, status, dates, date, setDate, report, timeline, state, refresh, pollNow, q }}>
      {children}
    </DataContext.Provider>
  );
}

export const useData = () => useContext(DataContext);
