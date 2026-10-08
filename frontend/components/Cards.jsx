'use client';

// Overview cards: KPIs, directional bias, expected range, alerts, seller positioning.

import { ACTION_LABEL, COMP_LABEL, biasColor, fmt, fmtL, signed, time } from '@/lib/format';

export function Kpis({ report: r }) {
  const m = r.market;
  const chg = m.spot - m.spotOpen;
  const items = [
    [`${r.symbol} spot`, fmt(m.spot, 2), `${chg >= 0 ? '+' : '−'}${fmt(Math.abs(chg), 1)} since ${time(r.sessionStart)}`],
    [
      'ATM IV',
      `${fmt(m.atmIv, 2)}%`,
      [
        m.ivSource,
        m.ivp != null ? `IVP ${fmt(m.ivp, 0)}` : null,
        m.ivSource?.startsWith('Sensibull') && m.chainAtmIv != null ? `ours ${fmt(m.chainAtmIv, 1)}%` : `ATM ${m.atmStrike}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    ['India VIX', fmt(m.vix, 2), m.vix == null ? 'add a Kite session' : m.vixOpen != null ? `${m.vix >= m.vixOpen ? '+' : '−'}${fmt(Math.abs(m.vix - m.vixOpen), 2)} since first reading` : '30-day index vol'],
    ['Time to expiry', `${fmt(m.hoursToExpiry, 1)} h`, new Date(r.expiry).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })],
    ['Forward (expiry)', m.forward != null ? fmt(m.forward, 1) : '–', m.forward != null ? `${m.forward - m.spot >= 0 ? '+' : '−'}${fmt(Math.abs(m.forward - m.spot), 1)} vs spot · PCR ${fmt(m.pcr, 2)}` : `PCR ${fmt(m.pcr, 2)}`],
    ['Prices as of', time(r.pricedAt ?? r.timestamp), `OI as of ${time(r.timestamp)} · ${r.snapshotCount} OI readings`],
  ];
  return (
    <section className="kpis">
      {items.map(([l, v, s]) => (
        <div className="kpi" key={l}>
          <div className="label">{l}</div>
          <div className="value">{v}</div>
          <div className="sub">{s}</div>
        </div>
      ))}
    </section>
  );
}

/** Headline = the day bias (everything since the first reading, smoothed, sticky label). The pulse (session + last 9 min) is secondary. */
export function BiasCard({ bias: b, pulse, since }) {
  const p = b.probabilities;
  const comps = Object.entries(b.components).filter(([, c]) => c && c.weight);
  const sgn = (n) => (n > 0 ? '+' : '') + n;
  return (
    <article className="card">
      <h2>Day bias <span className="muted small">— everything since {since}</span></h2>
      <div className="bias-head">
        <span className="bias-label" style={{ color: biasColor(b.score) }}>{b.label}</span>
        <span className="pill">Score {sgn(b.score)} / 100</span>
        <span className="pill">Confidence {b.confidence}%</span>
        <span className="pill">Sideways {b.range.score}/100</span>
      </div>
      <div className="stack" role="img" aria-label={`Bullish ${p.bullish}%, neutral ${p.neutral}%, bearish ${p.bearish}%`}>
        <div style={{ width: `${p.bullish}%`, background: 'var(--good)' }} />
        <div style={{ width: `${p.neutral}%`, background: 'var(--neutral)' }} />
        <div style={{ width: `${p.bearish}%`, background: 'var(--critical)' }} />
      </div>
      <div className="stack-legend">
        <span><span className="dot" style={{ background: 'var(--good)' }} /> Bullish <b>{p.bullish}%</b></span>
        <span><span className="dot" style={{ background: 'var(--neutral)' }} /> Neutral <b>{p.neutral}%</b></span>
        <span><span className="dot" style={{ background: 'var(--critical)' }} /> Bearish <b>{p.bearish}%</b></span>
      </div>
      {pulse && (
        <p className="note" style={{ margin: '0 0 14px' }}>
          Pulse (last 9 min): <b style={{ color: biasColor(pulse.score) }}>{pulse.label} ({sgn(pulse.score)})</b>
          <span className="muted"> — short-term read; the day bias above only moves on sustained evidence.</span>
        </p>
      )}
      <h3 className="small muted" style={{ margin: '0 0 6px' }}>What the day bias is built from (latest reading)</h3>
      <div className="components">
        {comps.map(([k, c]) => {
          const v = Math.max(-1, Math.min(1, c.value));
          return (
            <div className="comp" key={k}>
              <span className="name">
                {COMP_LABEL[k] ?? k} <span className="muted small">{Math.round(c.weight * 100)}%</span>
              </span>
              <div className="div-bar">
                <div className="fill" style={{ left: `${v < 0 ? 50 + v * 50 : 50}%`, width: `${Math.abs(v) * 50}%`, background: v >= 0 ? 'var(--good)' : 'var(--critical)' }} />
                <div className="mid" />
              </div>
              <span className="num">{v > 0 ? '+' : ''}{fmt(v * 100)}</span>
              <div className="why">{c.reason}</div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function RangeCard({ report: r }) {
  const e = r.expectedRange;
  // scale covers the 2σ range and both seller walls, so every marker sits on the bar
  const lo = Math.min(e.lower2, r.levels.support ?? Infinity) - 20;
  const hi = Math.max(e.upper2, r.levels.resistance ?? -Infinity) + 20;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const band = (a, b, alpha) => (
    <div className="band" style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%`, background: `color-mix(in srgb, var(--accent) ${alpha}%, transparent)` }} />
  );
  const marker = (v, color, label, top) =>
    v == null ? null : (
      <>
        <div className="marker" style={{ left: `${pct(v)}%`, background: color }} />
        <div className="tick" style={{ left: `${pct(v)}%`, ...(top ? { top: -18 } : { bottom: -20 }) }}>{label}</div>
      </>
    );
  const s = r.suggestions;
  return (
    <article className="card">
      <h2>Expected range to expiry</h2>
      <div className="range-bar">
        <div className="band" style={{ left: 0, width: '100%', background: 'var(--grid)' }} />
        {band(e.lower1, e.upper1, 25)}
        {band(e.expiryZoneLow, e.expiryZoneHigh, 55)}
        {marker(r.levels.support, 'var(--pe)', `S ${r.levels.support}`)}
        {marker(r.levels.resistance, 'var(--ce)', `R ${r.levels.resistance}`)}
        {marker(r.market.spot, 'var(--text-primary)', `Spot ${fmt(r.market.spot)}`, true)}
        <div className="tick" style={{ left: 0, transform: 'none', bottom: -20 }}>{fmt(lo)}</div>
        <div className="tick" style={{ right: 0, left: 'auto', transform: 'none', bottom: -20 }}>{fmt(hi)}</div>
      </div>
      <div className="kv">
        <div><span>1σ move (≈68%)</span>±{fmt(e.move1)} → {fmt(e.lower1)} – {fmt(e.upper1)}</div>
        <div><span>2σ (≈95%)</span>{fmt(e.lower2)} – {fmt(e.upper2)}</div>
        <div><span>ATM straddle</span>{e.straddle != null ? `₹${fmt(e.straddle, 1)} → ${fmt(e.straddleLower)} – ${fmt(e.straddleUpper)}` : '–'}</div>
        {r.market.sensibullStraddle != null && <div><span>ATM straddle (Sensibull)</span>₹{fmt(r.market.sensibullStraddle, 1)}</div>}
        {r.market.maxPain != null && <div><span>Max pain (Sensibull)</span>{fmt(r.market.maxPain)}</div>}
        <div><span>Expected expiry zone</span><b>{fmt(e.expiryZoneLow)} – {fmt(e.expiryZoneHigh)}</b></div>
        <div><span>Suggested short CE</span>{s.ce ? <><b>{s.ce.strike}</b> · {s.ce.adjProbOtm}% OTM</> : 'none meets target'}</div>
        <div><span>Suggested short PE</span>{s.pe ? <><b>{s.pe.strike}</b> · {s.pe.adjProbOtm}% OTM</> : 'none meets target'}</div>
      </div>
      <p className="muted small">
        Light band: 1σ range. Dark band: 1σ range bounded by the seller walls. Suggested = nearest strike with adjusted OTM
        probability ≥ {s.targetProb}% and no short covering.
      </p>
    </article>
  );
}

const ALERT_COLOR = { critical: 'var(--critical)', warning: '#b07800', info: 'var(--accent)' };

export function AlertsCard({ alerts }) {
  return (
    <section className="card">
      <h2>Alerts <span className="muted small">— when the seller thesis is breaking</span></h2>
      <ul className="alerts">
        {alerts.length ? (
          alerts.map((a, i) => (
            <li key={i}>
              <span className="tag" style={{ background: ALERT_COLOR[a.level] }}>{a.level}</span>
              <span>{a.text}</span>
            </li>
          ))
        ) : (
          <li className="muted">No alerts — seller structure intact.</li>
        )}
      </ul>
    </section>
  );
}

export function LevelsCard({ levels: l }) {
  const wall = (w) => (
    <li key={w.strike}>
      <b>{w.strike}</b> {fmtL(w.oi)} <span>({signed(w.sessionDOi)} today · {ACTION_LABEL[w.sessionAction]})</span>
    </li>
  );
  const writing = (list) =>
    list.length ? list.map((w) => <li key={w.strike}><b>{w.strike}</b> {signed(w.dOi)}</li>) : <li className="muted">none yet</li>;
  const mig = (open, now) => (open != null && open !== now ? <>{open} → <b>{now}</b></> : <b>{now ?? '–'}</b>);
  return (
    <article className="card">
      <h2>Seller positioning</h2>
      <div className="levels-grid">
        <div><span className="dot" style={{ background: 'var(--pe)' }} /> <b>Support (put walls)</b> {mig(l.supportOpen, l.support)}<ol>{l.supports.map(wall)}</ol></div>
        <div><span className="dot" style={{ background: 'var(--ce)' }} /> <b>Resistance (call walls)</b> {mig(l.resistanceOpen, l.resistance)}<ol>{l.resistances.map(wall)}</ol></div>
        <div><b>Fresh put OI today</b><ol>{writing(l.topPutWriting)}</ol></div>
        <div><b>Fresh call OI today</b><ol>{writing(l.topCallWriting)}</ol></div>
      </div>
    </article>
  );
}
