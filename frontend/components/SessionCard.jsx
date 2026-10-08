'use client';

// "Paste today's curl" card shared by the Data Sessions and Settings pages.

import { useCallback, useEffect, useState } from 'react';
import { api, postJson } from '@/lib/api';

export const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '–');
const istDay = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** One "paste today's curl" card. `renderDetails(status)` shows provider-specific status rows. */
export function SessionCard({ title, endpoint, steps, placeholder, renderDetails, onSaved }) {
  const [status, setStatus] = useState(null);
  const [curl, setCurl] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api(endpoint).then(setStatus).catch((e) => setMsg({ kind: 'bad', text: e.message })), [endpoint]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await postJson(endpoint, { curl }));
      setCurl(''); // don't keep credentials on screen
      setMsg({ kind: 'ok', text: 'Session saved. Fetching data now…' });
      setTimeout(() => {
        load();
        onSaved?.();
      }, 5000);
    } catch (e) {
      setMsg({ kind: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm(`Forget the stored ${title} session?`)) return;
    setStatus(await api(endpoint, { method: 'DELETE' }));
  };

  const today = istDay(new Date().toISOString());
  const fresh = status?.savedAt && istDay(status.savedAt) === today;

  return (
    <section className="card form">
      <h2>{title}</h2>
      {status &&
        (!status.configured ? (
          <p className="note warn">No session stored. Paste today's curl below.</p>
        ) : (
          <p className={`note ${status.expired ? 'bad' : fresh ? 'ok' : 'warn'}`}>
            {status.expired ? 'Session expired — paste a fresh curl.' : fresh ? `Session active · saved ${dt(status.savedAt)}` : `Saved ${dt(status.savedAt)} — paste today's curl.`}
          </p>
        ))}
      {status?.configured && renderDetails(status)}

      <ol className="small muted" style={{ paddingLeft: 18, margin: '12px 0 0' }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <label>
        cURL command
        <textarea rows={6} className="mono" value={curl} onChange={(e) => setCurl(e.target.value)} placeholder={placeholder} spellCheck={false} />
      </label>
      <div className="dialog-actions">
        {status?.configured && (
          <button type="button" onClick={forget}>
            Forget session
          </button>
        )}
        <button type="button" className="primary" onClick={save} disabled={busy || !curl.trim()}>
          {busy ? 'Saving…' : 'Save session'}
        </button>
      </div>
      {msg && <p className={`note ${msg.kind}`}>{msg.text}</p>}
    </section>
  );
}

export function ResultRow({ label, r, okText }) {
  return (
    <li>
      <span className="tag" style={{ background: r.ok ? 'var(--good)' : 'var(--critical)' }}>{r.ok ? 'ok' : 'error'}</span>
      <span>
        <b>{label}</b> · {dt(r.at)} — {r.ok ? okText : r.error}
      </span>
    </li>
  );
}

