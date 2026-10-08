'use client';

// Dhan order-flow curl card (Settings tab) — one session per index, following the sidebar's NIFTY/SENSEX switch.

import { SessionCard, ResultRow, dt } from '@/components/SessionCard';

/** Daily Dhan order-flow curl for the instrument selected in the sidebar (NIFTY and SENSEX each have their own). */
export function DhanCard({ symbol, endpoint }) {
  const exch = symbol === 'SENSEX' ? 'BSE' : 'NSE';
  return (
    <SessionCard
      title={`Dhan order flow — ${symbol} futures`}
      endpoint={endpoint}
      steps={[
        <>Open Dhan DEXT charts → the {symbol} <b>futures</b> contract you want (e.g. October, {exch}) with order flow on.</>,
        <>DevTools → Network → <code>getOrderFlow</code> → right-click → Copy → <b>Copy as cURL (bash)</b>.</>,
        <>Paste and save. Switch the sidebar to {symbol === 'SENSEX' ? 'NIFTY' : 'SENSEX'} to paste that index’s curl. Shown on the Order Flow tab only — never used by the model.</>,
      ]}
      placeholder="curl --url 'https://ticks.dhan.co/orderflow/getOrderFlow' -H 'Auth: …' --data-raw '{&quot;SEC_ID&quot;:…}'"
      renderDetails={(s) => (
        <>
          <div className="kv" style={{ marginTop: 12 }}>
            <div><span>Contract</span>{s.instrument ?? `SEC_ID ${s.secId}`}{s.expiry ? ` · expires ${s.expiry}` : ''}</div>
            <div><span>Login valid until</span>{dt(s.tokenExpiresAt)}</div>
          </div>
          {s.lastResult && (
            <ul className="alerts" style={{ marginTop: 12 }}>
              <ResultRow label="Order flow" r={s.lastResult} okText={`${s.lastResult.candles} candles${s.lastResult.last ? `, last ${s.lastResult.last.slice(11, 16)}` : ''}`} />
            </ul>
          )}
        </>
      )}
    />
  );
}
