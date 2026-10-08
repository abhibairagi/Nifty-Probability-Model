'use client';

// OI Analysis → Multi-strike OI: how OI at chosen strikes rose or fell through the day, against spot.
// Two stacked panels on one time axis (spot above, OI below) — never a dual-axis chart. Up to 6 lines, each keeps
// its colour for as long as it stays selected; every line is labelled at its end and listed in the table.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useData } from './DataProvider';
import { useTooltip } from './Tooltip';
import { fmt, fmtL, signed, time } from '@/lib/format';

const MAX_LINES = 6;
const SLOTS = [1, 2, 3, 4, 5, 6].map((i) => `var(--series-${i})`);
const PRESETS = [
  { key: 'freshPut', label: 'Fresh put OI today', hint: 'puts with the most OI added since yesterday’s close' },
  { key: 'putWalls', label: 'Put walls', hint: 'biggest put OI now (support)' },
  { key: 'callWalls', label: 'Call walls', hint: 'biggest call OI now (resistance)' },
  { key: 'freshCall', label: 'Fresh call OI today', hint: 'calls with the most OI added since yesterday’s close' },
];
const keyOf = (l) => `${l.strike}-${l.side}`;
const nameOf = (l) => `${fmt(l.strike)} ${l.side.toUpperCase()}`;

export default function MultiStrikeOi() {
  const { q, report, date } = useData();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [preset, setPreset] = useState('freshPut');
  const [lines, setLines] = useState([]); // [{ strike, side, slot }]

  // reload whenever a new reading arrives (the provider refreshes the report every 20 s)
  useEffect(() => {
    api(q('/api/oi/series', { withDate: true }))
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [q, report?.timestamp]);

  // new instrument / day → start again from the chosen preset
  const ident = data ? `${data.symbol}|${data.date}` : null;
  useEffect(() => {
    if (data) applyPreset(preset, data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ident]);

  function applyPreset(key, d = data) {
    setPreset(key);
    setLines((d?.presets?.[key] ?? []).slice(0, MAX_LINES).map((l, i) => ({ strike: l.strike, side: l.side, slot: i })));
  }

  function toggle(strike, side) {
    setPreset(null);
    setLines((cur) => {
      if (cur.some((l) => l.strike === strike && l.side === side)) return cur.filter((l) => !(l.strike === strike && l.side === side));
      if (cur.length >= MAX_LINES) return cur;
      const used = new Set(cur.map((l) => l.slot));
      const slot = [0, 1, 2, 3, 4, 5].find((s) => !used.has(s));
      return [...cur, { strike, side, slot }];
    });
  }

  if (error) return <p className="empty">{error}</p>;
  if (!data) return <p className="empty">Loading…</p>;

  const byStrike = new Map(data.strikes.map((r) => [r.strike, r]));
  const series = lines
    .map((l) => ({ ...l, color: SLOTS[l.slot], leg: byStrike.get(l.strike)?.[l.side] }))
    .filter((l) => l.leg);

  return (
    <>
      <section className="card">
        <div className="ms-presets" role="group" aria-label="Start from">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={preset === p.key ? 'on' : ''} onClick={() => applyPreset(p.key)} title={p.hint}>
              {p.label}
            </button>
          ))}
          <span className="muted small">
            {data.symbol} · expiry {new Date(data.expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })} · {data.times.length} readings · max {MAX_LINES} lines
          </span>
        </div>
        {series.length ? (
          <MsChart data={data} series={series} />
        ) : (
          <p className="muted">Pick a preset above or tick strikes in the table below.</p>
        )}
      </section>

      <section className="card">
        <h2>
          Strikes <span className="muted small">— tick CE / PE to plot · fresh = OI now − yesterday’s close · {date}</span>
        </h2>
        <StrikePicker data={data} lines={lines} onToggle={toggle} full={lines.length >= MAX_LINES} />
      </section>
    </>
  );
}

/** Spot panel + OI panel on one time axis, shared crosshair and tooltip, end-of-line labels. */
function MsChart({ data, series }) {
  const { tip, show, hide } = useTooltip();
  const box = useRef(null);
  const [W, setW] = useState(720);
  const [hover, setHover] = useState(null); // reading index

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const n = data.times.length;
  const padL = 52;
  const padR = W < 520 ? 12 : 92; // room for end labels
  const ts = useMemo(() => data.times.map((t) => new Date(t).getTime()), [data.times]);
  const x = (i) => padL + ((ts[i] - ts[0]) / Math.max(1, ts[n - 1] - ts[0])) * (W - padL - padR);

  const spots = data.spot.filter((v) => v != null);
  const sPad = Math.max(5, (Math.max(...spots) - Math.min(...spots)) * 0.1);
  const ois = series.flatMap((s) => s.leg.oi.filter((v) => v != null));
  const oiHi = Math.max(1, ...ois) * 1.08;

  const nearest = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  const onMove = (e) => {
    const i = nearest(e);
    setHover(i);
    show(e, time(data.times[i]), [
      ['Spot', fmt(data.spot[i], 2)],
      ...series.map((s) => {
        const v = s.leg.oi[i];
        const first = s.leg.oi.find((o) => o != null);
        return [nameOf(s), v == null ? '–' : `${fmtL(v)} (${signed(v - first)} since open)`];
      }),
    ]);
  };
  const onLeave = () => {
    setHover(null);
    hide();
  };

  const panel = ({ H, lo, hi, ticks, fmtTick, lines: ls, labels }) => {
    const y = (v) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
    const path = (vals) => {
      let d = '';
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) return void (pen = false);
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    // readings with no neighbour on either side (strike briefly inside Sensibull's window) would be invisible as a path
    const lone = (vals) => vals.map((v, i) => (v != null && vals[i - 1] == null && vals[i + 1] == null ? i : -1)).filter((i) => i >= 0);
    // end labels, nudged apart so they never overlap
    const ends = labels
      ? ls
          .map((l) => {
            const i = l.vals.findLastIndex((v) => v != null);
            return i < 0 ? null : { ...l, ly: y(l.vals[i]), lx: x(i) };
          })
          .filter(Boolean)
          .sort((a, b) => a.ly - b.ly)
      : [];
    for (let k = 1; k < ends.length; k++) ends[k].ly = Math.max(ends[k].ly, ends[k - 1].ly + 13);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', overflow: 'visible' }} onMouseMove={onMove} onMouseLeave={onLeave}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">{fmtTick(t)}</text>
          </g>
        ))}
        {ls.map((l) => (
          <g key={l.key}>
            <path d={path(l.vals)} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {lone(l.vals).map((i) => (
              <circle key={i} cx={x(i)} cy={y(l.vals[i])} r="3" fill={l.color} />
            ))}
          </g>
        ))}
        {padR > 40 &&
          ends.map((l) => (
            <text key={l.key} x={W - padR + 6} y={l.ly + 4} style={{ fill: 'var(--text-secondary)', fontWeight: 600 }}>
              <tspan style={{ fill: l.color }}>● </tspan>
              {l.label}
            </text>
          ))}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={4} y2={H - 8} stroke="var(--text-muted)" />
            {ls.map((l) =>
              l.vals[hover] == null ? null : (
                <circle key={l.key} cx={x(hover)} cy={y(l.vals[hover])} r="4" fill={l.color} stroke="var(--surface-1)" strokeWidth="2" />
              ),
            )}
          </>
        )}
      </svg>
    );
  };

  const sLo = Math.min(...spots) - sPad;
  const sHi = Math.max(...spots) + sPad;
  return (
    <div ref={box} style={{ marginTop: 12 }}>
      <div className="oi-legend">
        {series.map((s) => (
          <span key={keyOf(s)}>
            <span className="dot" style={{ background: s.color }} /> {nameOf(s)}
          </span>
        ))}
      </div>
      <div className="muted small">{data.symbol} spot</div>
      {panel({
        H: 110,
        lo: sLo,
        hi: sHi,
        ticks: [sLo + sPad, sHi - sPad],
        fmtTick: (t) => fmt(t),
        lines: [{ key: 'spot', vals: data.spot, color: 'var(--text-secondary)' }],
      })}
      <div className="muted small" style={{ marginTop: 10 }}>Open interest</div>
      {panel({
        H: 280,
        lo: 0,
        hi: oiHi,
        ticks: [0, oiHi / 3, (2 * oiHi) / 3].map((t) => Math.round(t)),
        fmtTick: (t) => (t === 0 ? '0' : fmtL(t)),
        lines: series.map((s) => ({ key: keyOf(s), vals: s.leg.oi, color: s.color, label: nameOf(s) })),
        labels: true,
      })}
      <div className="muted small" style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: padL, paddingRight: padR }}>
        <span>{time(data.times[0])}</span>
        <span>{time(data.times[n - 1])}</span>
      </div>
      {tip}
    </div>
  );
}

/** All strikes: CE side | strike | PE side, with fresh OI today and OI now — tick a side to plot it. */
function StrikePicker({ data, lines, onToggle, full }) {
  const sel = new Map(lines.map((l) => [keyOf(l), l]));
  const spot = data.spot.at(-1);
  const maxFresh = Math.max(1, ...data.strikes.flatMap((r) => [Math.abs(r.ce.fresh ?? 0), Math.abs(r.pe.fresh ?? 0)]));
  const cell = (r, side) => {
    const l = sel.get(`${r.strike}-${side}`);
    return (
      <td style={{ textAlign: 'center' }}>
        <input
          type="checkbox"
          checked={!!l}
          disabled={!l && full}
          onChange={() => onToggle(r.strike, side)}
          aria-label={`Plot ${fmt(r.strike)} ${side.toUpperCase()}`}
          style={l ? { accentColor: SLOTS[l.slot] } : undefined}
        />
      </td>
    );
  };
  const bar = (v, color) => (
    <span className="ms-bar" aria-hidden="true">
      <span style={{ width: `${(Math.abs(v ?? 0) / maxFresh) * 100}%`, background: v < 0 ? 'var(--neutral)' : color }} />
    </span>
  );
  // nearest strike to spot marks the ATM row
  const atm = data.strikes.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a.strike - spot) ? r : a), data.strikes[0]).strike;
  return (
    <div className="table-wrap">
      <table className="ms-table">
        <thead>
          <tr>
            <th>CE fresh today</th><th>CE OI</th><th>Plot</th><th style={{ textAlign: 'center' }}>Strike</th><th>Plot</th><th>PE OI</th><th>PE fresh today</th>
          </tr>
        </thead>
        <tbody>
          {data.strikes.map((r) => (
            <tr key={r.strike} className={r.strike === atm ? 'atm' : ''}>
              <td>
                {bar(r.ce.fresh, 'var(--ce)')} {r.ce.fresh == null ? '–' : signed(r.ce.fresh)}
              </td>
              <td>{r.ce.now == null ? '–' : fmtL(r.ce.now)}</td>
              {cell(r, 'ce')}
              <td style={{ textAlign: 'center', fontWeight: 600 }}>{fmt(r.strike)}{r.strike === atm ? ' ◆' : ''}</td>
              {cell(r, 'pe')}
              <td>{r.pe.now == null ? '–' : fmtL(r.pe.now)}</td>
              <td>
                {bar(r.pe.fresh, 'var(--pe)')} {r.pe.fresh == null ? '–' : signed(r.pe.fresh)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginBottom: 0 }}>
        ◆ = strike nearest spot. Fresh OI uses Sensibull’s previous-day OI for each strike. Sensibull sends ATM ± 10 strikes, so far strikes have
        OI only while spot was near them — presets pick strikes seen for most of the day.
      </p>
    </div>
  );
}
