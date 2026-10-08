'use client';

import { useState } from 'react';
import { postJson } from '@/lib/api';
import { useData } from '@/components/DataProvider';

const EXAMPLE = `{
  "timestamp": "2026-10-06T10:03:00+05:30",
  "expiry": "2026-10-06T15:30:00+05:30",
  "spot": 22450.5,
  "vix": 15.16,
  "strikes": [
    { "strike": 22400,
      "ce": { "oi": 5400000, "ltp": 92.5, "volume": 1200000, "iv": 19.8 },
      "pe": { "oi": 7100000, "ltp": 41.2, "volume": 1500000, "iv": 20.6 } },
    { "strike": 22450,
      "ce": { "oi": 6100000, "ltp": 61.0, "volume": 1900000, "iv": 19.6 },
      "pe": { "oi": 5200000, "ltp": 60.1, "volume": 1700000, "iv": 20.1 } },
    { "strike": 22500,
      "ce": { "oi": 8300000, "ltp": 38.4, "volume": 1600000, "iv": 19.5 },
      "pe": { "oi": 3900000, "ltp": 87.9, "volume": 900000, "iv": 19.9 } }
  ]
}`;

export default function DataPage() {
  const { symbol, dates, status, date, setDate, timeline, refresh, q } = useData();
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState('');

  const ingest = async () => {
    try {
      const r = await postJson('/api/snapshot', { symbol, ...JSON.parse(json) });
      setMsg(`Stored. Bias now ${r.bias.label} (${r.bias.score}).`);
      setJson('');
      refresh();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    }
  };

  return (
    <>
      <h1 className="page-title">Data &amp; Snapshots — {symbol}</h1>
      <div className="grid two">
        <section className="card">
          <h2>Stored sessions</h2>
          <p className="muted small">One JSON file per IST trading day in <code>backend/data/{symbol}/snapshots/</code>, plus a bias timeline per day in <code>backend/data/{symbol}/reports/</code> — this is the history we'll backtest on.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Session</th><th>Readings</th><th>Raw JSON</th><th></th></tr></thead>
              <tbody>
                {dates.map((d) => (
                  <tr key={d}>
                    <td>{d}{d === status?.today ? ' (today)' : ''}</td>
                    <td>{d === date ? timeline.length : ''}</td>
                    <td><a href={q('/api/snapshots', { params: { date: d } })} target="_blank" rel="noreferrer">download</a></td>
                    <td>{d === date ? <b>viewing</b> : <button type="button" onClick={() => setDate(d)}>View</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card form">
          <h2>Push a snapshot manually</h2>
          <p className="muted small">Paste one snapshot in the normalized format. It is stored under its <code>symbol</code> field (default: {symbol}).</p>
          <label>
            Snapshot JSON
            <textarea rows={12} value={json} placeholder={EXAMPLE} onChange={(e) => setJson(e.target.value)} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setJson(EXAMPLE)}>Insert example</button>
            <button type="button" className="primary" onClick={ingest} disabled={!json.trim()}>Ingest</button>
          </div>
          {msg && <p className="muted small">{msg}</p>}
        </section>
      </div>
    </>
  );
}
