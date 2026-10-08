'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useData } from './DataProvider';
import ThemeToggle from './ThemeToggle';
import { biasColor, fmt, time } from '@/lib/format';

const NAV = [
  { href: '/', label: 'Overview', icon: 'M3 12l9-8 9 8M5 10v10h14V10' },
  { href: '/oi', label: 'OI Analysis', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { href: '/strikes', label: 'Strike Probabilities', icon: 'M4 6h16M4 12h16M4 18h16' },
  { href: '/timeline', label: 'Timeline', icon: 'M3 17l6-6 4 4 8-8' },
  { href: '/orderflow', label: 'Order Flow', icon: 'M4 18V9M9 18V5M14 18v-6M19 18V8M3 21h18' },
  { href: '/session', label: 'Data Sessions', icon: 'M15 7a4 4 0 11-8 0 4 4 0 018 0zM3 21a8 8 0 0116 0M19 8v6M22 11h-6' },
  { href: '/data', label: 'Data & Snapshots', icon: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' },
  { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 110-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 3.1V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9h.1a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' },
];

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { instruments, symbol, setSymbol, status, dates, date, setDate, report, pollNow } = useData();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null); // INDstocks tick (display only)

  useEffect(() => {
    if (!symbol) return;
    let stop = false;
    setLive(null);
    const pull = () => api(`/api/live?symbol=${symbol}`).then((l) => !stop && setLive(l)).catch(() => {});
    pull();
    const id = setInterval(pull, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [symbol]);
  const liveFresh = live?.ltp != null && live.ageMs < 15_000 && live.symbol === symbol;

  const fetchNow = async () => {
    setBusy(true);
    try {
      await pollNow();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="menu-btn" type="button" aria-label="Open navigation" onClick={() => setOpen(true)}>
        <Icon d="M4 6h16M4 12h16M4 18h16" />
      </button>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sb-brand">
          <strong>Expiry Probability Model</strong>
          <span className="muted small">Seller positioning · OTM probability</span>
        </div>

        {/* instrument switcher appears once more than one instrument is enabled (SYMBOLS in backend/.env) */}
        {instruments.filter((i) => i.enabled).length > 1 && (
          <div className="sb-switch" role="tablist" aria-label="Instrument">
            {instruments.filter((i) => i.enabled).map((i) => (
              <button
                key={i.symbol}
                type="button"
                role="tab"
                aria-selected={symbol === i.symbol}
                className={symbol === i.symbol ? 'on' : ''}
                onClick={() => symbol !== i.symbol && setSymbol(i.symbol)}
                title={i.name ? `${i.name} · ${i.exchange}` : i.symbol}
              >
                {i.symbol}
              </button>
            ))}
          </div>
        )}

        {report && (
          <div className="sb-live">
            <div className="muted small">{report.symbol}</div>
            <div className="sb-spot">{fmt(liveFresh ? live.ltp : report.market.spot, 2)}</div>
            {liveFresh && (
              <div className="small" style={{ color: 'var(--buy)', fontWeight: 600 }} title="Live tick from INDstocks (display only — the model uses Kite's 1-minute spot)">
                ● live {new Date(live.at).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}
              </div>
            )}
            <div className="small" style={{ color: biasColor(report.dayBias.score), fontWeight: 600 }}>
              Day: {report.dayBias.label} ({report.dayBias.score > 0 ? '+' : ''}
              {report.dayBias.score})
            </div>
            <div className="muted small">prices {time(report.pricedAt ?? report.timestamp)} · OI {time(report.timestamp)}</div>
          </div>
        )}

        <nav className="sb-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={pathname === n.href ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon d={n.icon} />
              {n.label}
              {n.href === '/' && report?.alerts?.length > 0 && <span className="badge">{report.alerts.length}</span>}
            </Link>
          ))}
        </nav>

        <div className="sb-foot">
          <ThemeToggle />
          <label className="small muted">
            Session
            <select value={date ?? ''} onChange={(e) => setDate(e.target.value)}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d === status?.today ? `${d} (today)` : d}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={fetchNow} disabled={busy}>
            {busy ? 'Fetching…' : 'Fetch now'}
          </button>
          {status && (
            <div className="muted small">
              {status.provider}
              {status.polling ? ` · OI every ${status.pollMinutes} min · prices every ${status.priceSeconds ?? 60} s` : ' · not polling'}
              <br />
              market {status.marketOpen ? 'open' : 'closed'}
              {status.forced ? ' (forced)' : ''}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
