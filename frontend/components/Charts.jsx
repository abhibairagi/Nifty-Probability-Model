'use client';

// OI-by-strike butterfly, strike probability tables and the session timeline.

import { useEffect, useRef, useState } from 'react';
import { useTooltip } from './Tooltip';
import { ACTION_LABEL, fmt, fmtL, signed, time } from '@/lib/format';

export function OiChart({ report: r }) {
  const { tip, show, hide } = useTooltip();
  const rows = [...r.oiChart].sort((a, b) => b.strike - a.strike);
  const max = Math.max(1, ...rows.flatMap((d) => [d.ceOi, d.peOi]));
  const last = new Map((r.lastInterval ?? []).map((d) => [d.strike, d]));
  const spotRowStrike = rows.find((d) => d.strike < r.market.spot)?.strike; // first strike below spot gets the spot line

  return (
    <section className="card">
      <h2>Open interest by strike <span className="muted small">— bars: current OI · text: change since first snapshot</span></h2>
      <div className="oi-legend">
        <span><span className="dot" style={{ background: 'var(--pe)' }} /> Put OI (PE)</span>
        <span><span className="dot" style={{ background: 'var(--ce)' }} /> Call OI (CE)</span>
        <span className="muted">dashed line = spot {fmt(r.market.spot, 1)}</span>
      </div>
      {rows.map((d) => {
        const li = last.get(d.strike);
        const cls = ['oi-row', d.strike === r.market.atmStrike && 'atm', d.strike === spotRowStrike && 'spot-line'].filter(Boolean).join(' ');
        return (
          <div
            key={d.strike}
            className={cls}
            onMouseMove={(e) =>
              show(e, `Strike ${d.strike}`, [
                ['PE OI', fmtL(d.peOi)],
                ['PE Δ since first reading', signed(d.peDOi)],
                ...(d.pePrev != null ? [['PE Δ vs yesterday', signed(d.peOi - d.pePrev)]] : []),
                ...(d.pe5m != null ? [['PE Δ last 5 min', signed(d.pe5m)]] : []),
                ['PE last reading', li ? ACTION_LABEL[li.pe.action] : '–'],
                ['CE OI', fmtL(d.ceOi)],
                ['CE Δ since first reading', signed(d.ceDOi)],
                ...(d.cePrev != null ? [['CE Δ vs yesterday', signed(d.ceOi - d.cePrev)]] : []),
                ...(d.ce5m != null ? [['CE Δ last 5 min', signed(d.ce5m)]] : []),
                ['CE last reading', li ? ACTION_LABEL[li.ce.action] : '–'],
              ])
            }
            onMouseLeave={hide}
          >
            <div className="oi-side pe">
              <div className="b" style={{ width: `${(d.peOi / max) * 85}%`, background: 'var(--pe)' }} />
              <span className="chg">{signed(d.peDOi)}</span>
            </div>
            <div className="strike">{d.strike}</div>
            <div className="oi-side ce">
              <div className="b" style={{ width: `${(d.ceOi / max) * 85}%`, background: 'var(--ce)' }} />
              <span className="chg">{signed(d.ceDOi)}</span>
            </div>
          </div>
        );
      })}
      {tip}
    </section>
  );
}

export function StrikeTable({ title, rows, suggested }) {
  return (
    <article className="card">
      <h2>{title}</h2>
      {!rows.length ? (
        <p className="muted">No OTM strikes in range.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strike</th><th>Dist</th><th>LTP</th><th>IV</th><th>OI</th><th>Today</th><th>Last 9m</th><th>Stat %</th><th>Adj %</th><th>Safety</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const isSug = suggested && s.strike === suggested.strike;
                return (
                  <tr key={s.strike} className={isSug ? 'suggested' : ''}>
                    <td>{s.strike}{isSug ? ' ★' : ''}</td>
                    <td>{s.distance}</td>
                    <td>{fmt(s.ltp, 2)}</td>
                    <td>{fmt(s.iv, 1)}</td>
                    <td>{fmtL(s.oi)}</td>
                    <td><span className="act">{ACTION_LABEL[s.sessionAction]}</span></td>
                    <td><span className="act">{ACTION_LABEL[s.recentAction]}</span></td>
                    <td>{fmt(s.statProbOtm, 1)}</td>
                    <td><b>{fmt(s.adjProbOtm, 1)}</b></td>
                    <td>
                      <span className="safety">
                        {fmt(s.safety, 1)}
                        <span className="bar"><div style={{ width: `${s.safety * 10}%` }} /></span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

/** Two stacked panels sharing one time axis (bias score, spot) — never a dual-axis chart. */
export function Timeline({ points, symbol }) {
  const { tip, show, hide } = useTooltip();
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const [W, setW] = useState(560);

  // draw in real pixels so axis text stays 11px at any card width
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [points.length >= 2]);

  if (points.length < 2) return <p className="muted">Needs at least two snapshots.</p>;

  const H = 120;
  const padL = 48;
  const padR = 8;
  const t0 = new Date(points[0].timestamp).getTime();
  const t1 = new Date(points.at(-1).timestamp).getTime();
  const x = (p) => padL + ((new Date(p.timestamp).getTime() - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const spots = points.map((p) => p.spot);
  const pad = Math.max(10, (Math.max(...spots) - Math.min(...spots)) * 0.1);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p) - px) < Math.abs(x(best) - px)) best = p;
    setHover(best);
    show(e, time(best.timestamp), [
      ['Day bias', `${best.dayLabel ?? '–'} (${best.dayScore > 0 ? '+' : ''}${best.dayScore ?? '–'})`],
      ['Pulse (9 min)', `${best.label} (${best.score > 0 ? '+' : ''}${best.score})`],
      ['Spot', fmt(best.spot, 1)],
      ['Support / Resistance', `${best.support ?? '–'} / ${best.resistance ?? '–'}`],
      ['Suggested PE / CE', `${best.suggestedPe ?? '–'} / ${best.suggestedCe ?? '–'}`],
    ]);
  };
  const onLeave = () => {
    setHover(null);
    hide();
  };

  // series: [{ key, color, width, label }] — all drawn on the same y-scale
  const panel = (series, lo, hi, zero) => {
    const y = (v) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 24);
    const path = (key) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p[key] ?? 0).toFixed(1)}`).join('');
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', overflow: 'visible' }} onMouseMove={onMove} onMouseLeave={onLeave}>
        {[lo, (lo + hi) / 2, hi].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
          </g>
        ))}
        {zero != null && <line x1={padL} x2={W - padR} y1={y(zero)} y2={y(zero)} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        {series.map((sr) => (
          <path key={sr.key} d={path(sr.key)} fill="none" stroke={sr.color} strokeWidth={sr.width ?? 2} strokeLinejoin="round" opacity={sr.opacity ?? 1} />
        ))}
        {hover && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={4} y2={H - 12} stroke="var(--text-muted)" />
            {series.map((sr) => (
              <circle key={sr.key} cx={x(hover)} cy={y(hover[sr.key] ?? 0)} r="4" fill={sr.color} stroke="var(--surface-1)" strokeWidth="2" />
            ))}
          </>
        )}
      </svg>
    );
  };

  return (
    <div ref={box}>
      <div className="oi-legend" style={{ marginBottom: 2 }}>
        <span><span className="dot" style={{ background: 'var(--accent)' }} /> Day bias</span>
        <span><span className="dot" style={{ background: 'var(--ce)' }} /> Pulse (9 min)</span>
        <span className="muted">score −100 bearish … +100 bullish</span>
      </div>
      {panel(
        [
          { key: 'score', color: 'var(--ce)', width: 1.5, opacity: 0.6 },
          { key: 'dayScore', color: 'var(--accent)', width: 2.5 },
        ],
        -100,
        100,
        0,
      )}
      <div className="muted small" style={{ marginTop: 8 }}>{symbol ?? ''} spot</div>
      {panel([{ key: 'spot', color: 'var(--text-secondary)' }], Math.min(...spots) - pad, Math.max(...spots) + pad)}
      <div className="muted small" style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: `${(padL / W) * 100}%` }}>
        <span>{time(points[0].timestamp)}</span>
        <span>{time(points.at(-1).timestamp)}</span>
      </div>
      {tip}
    </div>
  );
}
