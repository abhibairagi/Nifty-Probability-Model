'use client';

import { useEffect, useState } from 'react';
import { api, postJson } from '@/lib/api';
import { useData } from '@/components/DataProvider';
import { COMP_LABEL } from '@/lib/format';
import { DhanCard } from '@/components/DhanCard';

const zonesToText = (zones = []) => zones.map((z) => `${z.from}-${z.to}`).join('\n');
const textToZones = (text) =>
  text
    .split('\n')
    .map((l) => l.trim().match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/))
    .filter(Boolean)
    .map((m) => ({ from: Number(m[1]), to: Number(m[2]) }));

export default function SettingsPage() {
  const { refresh, symbol, q } = useData();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!symbol) return;
    setForm(null);
    api(q('/api/config'))
      .then((c) => {
        setCfg(c);
        setForm({
          support: zonesToText(c.zones?.support),
          resistance: zonesToText(c.zones?.resistance),
          targetProbOtm: c.targetProbOtm,
          biasTilt: c.biasTilt,
          atmIvOverride: c.atmIvOverride ?? '',
          weights: Object.fromEntries(Object.entries(c.weights).filter(([k]) => k !== 'orderFlow')), // order flow is not part of the model
        });
      })
      .catch((e) => setSaved(`Could not load config: ${e.message}`));
  }, [symbol, q]);

  const title = `Settings — ${symbol ?? ''}`;
  if (!form) return <><h1 className="page-title">{title}</h1><p className="empty">{saved || 'Loading…'}</p></>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    await postJson(q('/api/config'), {
      zones: { support: textToZones(form.support), resistance: textToZones(form.resistance) },
      targetProbOtm: Number(form.targetProbOtm) || 85,
      biasTilt: Number(form.biasTilt) || 0,
      atmIvOverride: Number(form.atmIvOverride) > 0 ? Number(form.atmIvOverride) : null,
      weights: Object.fromEntries(Object.entries(form.weights).map(([k, v]) => [k, Number(v) || 0])),
    });
    setSaved(`Saved at ${new Date().toLocaleTimeString()}. Applies from the next analysis run.`);
    refresh();
  };

  return (
    <>
      <h1 className="page-title">{title}</h1>
      <form className="grid two" onSubmit={save}>
        <section className="card form">
          <h2>Your support / resistance zones</h2>
          <p className="muted small">One zone per line as <code>from-to</code>, e.g. <code>22300-22350</code>. Breaking a zone pushes the bias hard in that direction.</p>
          <label>Support zones<textarea rows={4} value={form.support} onChange={(e) => set('support', e.target.value)} /></label>
          <label>Resistance zones<textarea rows={4} value={form.resistance} onChange={(e) => set('resistance', e.target.value)} /></label>
        </section>
        <section className="card form">
          <h2>Model parameters</h2>
          <label>
            ATM IV (%) — used when the feed has no option IV (Sensibull OI feed)
            <input type="number" min="0" max="200" step="0.1" placeholder="e.g. 18.5" value={form.atmIvOverride} onChange={(e) => set('atmIvOverride', e.target.value)} />
          </label>
          <label>
            Target OTM probability for suggested strikes (%)
            <input type="number" min="50" max="99" step="1" value={form.targetProbOtm} onChange={(e) => set('targetProbOtm', e.target.value)} />
          </label>
          <label>
            Bias tilt (× expected move the bias shifts spot for “Adj %”)
            <input type="number" min="0" max="1" step="0.05" value={form.biasTilt} onChange={(e) => set('biasTilt', e.target.value)} />
          </label>
          <h3 className="small">Component weights</h3>
          <div className="weights">
            {Object.entries(form.weights).map(([k, v]) => (
              <label key={k}>
                {COMP_LABEL[k] ?? k}
                <input type="number" min="0" max="1" step="0.05" value={v} onChange={(e) => set('weights', { ...form.weights, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <p className="muted small">Weights are re-normalised over the components that have data (your S/R zones only count when set). Order flow is not part of the model — see the Order Flow tab.</p>
          <div className="dialog-actions">
            <button type="submit" className="primary">Save settings</button>
          </div>
          {saved && <p className="muted small">{saved}</p>}
        </section>
      </form>
      {symbol && <DhanCard key={symbol} symbol={symbol} endpoint={q('/api/dhan/session')} />}
      {cfg && <p className="muted small">Stored in <code>backend/data/{symbol}/config.json</code>. Each instrument has its own settings.</p>}
    </>
  );
}
