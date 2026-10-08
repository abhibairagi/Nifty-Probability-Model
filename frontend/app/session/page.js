'use client';

import { useData } from '@/components/DataProvider';
import { SessionCard, ResultRow, dt } from '@/components/SessionCard';

export default function SessionsPage() {
  const { refresh } = useData();

  return (
    <>
      <h1 className="page-title">Data Sessions</h1>
      <p className="muted small" style={{ margin: 0 }}>
        Paste one curl per source each morning. The login cookies are stored only on this machine in <code>backend/data/secrets/</code> (git-ignored,
        owner-read-only) and are never sent back to the browser. Treat a curl like a password.
      </p>
      <div className="grid two">
        <SessionCard
          title="Sensibull — option OI"
          endpoint="/api/sensibull/session"
          onSaved={refresh}
          steps={[
            'Open Sensibull → OI chart, logged in.',
            <>DevTools → Network → <code>oi_chart</code> → right-click → Copy → <b>Copy as cURL (bash)</b>.</>,
            'Paste and save. Only the cookies (login token) are used. A mid-day paste backfills from 09:15; the same login also feeds live ATM IV / IVP every minute.',
          ]}
          placeholder="curl --url 'https://oxide.sensibull.com/v1/compute/1/oi_graphs/oi_chart' …"
          renderDetails={(s) => (
            <>
              <div className="kv" style={{ marginTop: 12 }}>
                <div><span>Login valid until</span>{dt(s.tokenExpiresAt)}</div>
                <div><span>Current expiry</span>{s.intraday?.expiry ?? '–'}</div>
                {s.intradaySensex !== undefined && <div><span>SENSEX expiry</span>{s.intradaySensex?.expiry ?? '–'}</div>}
                <div><span>Taken from the curl</span>cookies (login token) only</div>
              </div>
              {s.intraday && (
                <ul className="alerts" style={{ marginTop: 12 }}>
                  <ResultRow
                    label="Live IV (compute_intraday)"
                    r={s.intraday}
                    okText={`expiry ${s.intraday.expiry} · ATM IV ${s.intraday.atmIv?.toFixed(2) ?? '–'}% · IVP ${s.intraday.ivp ?? '–'} · bar ${s.intraday.bar ?? '–'}`}
                  />
                </ul>
              )}
              {s.intradaySensex && (
                <ul className="alerts" style={{ marginTop: 12 }}>
                  <ResultRow
                    label="SENSEX live IV"
                    r={s.intradaySensex}
                    okText={`expiry ${s.intradaySensex.expiry} · ATM IV ${s.intradaySensex.atmIv?.toFixed(2) ?? '–'}% · IVP ${s.intradaySensex.ivp ?? '–'} · bar ${s.intradaySensex.bar ?? '–'}`}
                  />
                </ul>
              )}
              {Object.values(s.lastResult ?? {}).length > 0 && (
                <ul className="alerts" style={{ marginTop: 12 }}>
                  {Object.values(s.lastResult).map((r) => (
                    <ResultRow key={r.symbol} label={r.symbol} r={r} okText={r.waiting ? r.note : `spot ${r.spot}, ${r.strikes} strikes (data as of ${dt(r.dataTime)})`} />
                  ))}
                </ul>
              )}
            </>
          )}
        />
        <SessionCard
          title="INDstocks — live NIFTY / SENSEX ticks"
          endpoint="/api/indstocks/session"
          steps={[
            <>Open <b>indstocks.com → API Trading → Access Tokens</b>, logged in.</>,
            'Generate the access token and copy it (eyJ…). It is valid for about 24 hours — paste a new one each morning.',
            'Paste it below (the bare token, not a curl) and save. Shows the live index price in the sidebar; the model keeps using Kite’s 1-minute spot.',
          ]}
          placeholder="eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.…"
          renderDetails={(s) => (
            <>
              <div className="kv" style={{ marginTop: 12 }}>
                <div><span>Token valid until</span>{dt(s.tokenExpiresAt)}</div>
                <div><span>Feed</span>{s.feed?.connected ? `connected since ${dt(s.feed.since)}` : s.feed?.error ?? 'not connected'}</div>
                <div><span>Token from</span>{{ generated: 'auto-generated (TOTP)', env: 'IND_MONEY in .env', pasted: 'pasted here' }[s.source] ?? s.source}</div>
                <div>
                  <span>Auto token (TOTP)</span>
                  {!s.auto?.enabled
                    ? 'off — set IND_MPIN and IND_TOTP_SECRET in backend/.env'
                    : s.auto.stopped
                      ? `stopped after 2 failures: ${s.auto.error}`
                      : s.auto.at
                        ? `${s.auto.ok ? 'last generated' : 'last attempt failed'} ${dt(s.auto.at)}${s.auto.ok ? '' : ` — ${s.auto.error}`}`
                        : 'on — generates a new token when the current one expires'}
                </div>
              </div>
              {Object.keys(s.feed?.last ?? {}).length > 0 && (
                <ul className="alerts" style={{ marginTop: 12 }}>
                  {Object.entries(s.feed.last).map(([sym, l]) => (
                    <ResultRow key={sym} label={sym} r={{ ok: true, at: l.at }} okText={`${l.ltp} · ${l.ticks.toLocaleString('en-IN')} ticks today`} />
                  ))}
                </ul>
              )}
            </>
          )}
        />
        <SessionCard
          title="Kite (Zerodha) — India VIX"
          endpoint="/api/kite/session"
          onSaved={refresh}
          steps={[
            'Open Kite → a chart of INDIA VIX, logged in.',
            <>DevTools → Network → a <code>historical</code> request → right-click → Copy → <b>Copy as cURL (bash)</b>.</>,
            'Paste and save. VIX is then attached to every OI reading (and filled into today’s earlier ones).',
          ]}
          placeholder="curl --url 'https://kite.zerodha.com/oms/instruments/historical/264969/5minute?…' -H 'authorization: enctoken …' …"
          renderDetails={(s) => (
            <>
              <div className="kv" style={{ marginTop: 12 }}>
                <div><span>Kite user</span>{s.userId}</div>
                <div><span>Cookies captured</span>{s.cookieNames.length}</div>
              </div>
              {s.lastResult && (
                <ul className="alerts" style={{ marginTop: 12 }}>
                  <ResultRow label="INDIA VIX" r={s.lastResult} okText={`latest ${s.lastResult.vix ?? '–'}`} />
                </ul>
              )}
            </>
          )}
        />
      </div>
    </>
  );
}
