'use client';

// Order Flow tab visuals (Dhan NIFTY futures footprint). Display only — nothing here feeds the model.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTooltip } from './Tooltip';
import { fmt } from '@/lib/format';

/** Quantity, compact: 1,250 → 1.3K, 1,25,000 → 1.3L */
export const fmtQty = (n) => {
  if (n == null) return '–';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e5) return `${sign}${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 })}K`;
  return `${sign}${a.toLocaleString('en-IN')}`;
};
const signedQty = (n) => (n > 0 ? '+' : '') + fmtQty(n);
const hhmm = (c) => c.time.slice(11, 16);

function useWidth(min = 280) {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

export function summarize(candles) {
  if (!candles.length) return null;
  const sum = (k, list = candles) => list.reduce((a, c) => a + (c[k] ?? 0), 0);
  const last = candles.at(-1);
  const lastN = (n) => sum('delta', candles.slice(-n));
  const buy = sum('buy_volume');
  const sell = sum('sell_volume');
  return {
    cumDelta: last.cumulative_delta,
    buy,
    sell,
    buyPct: buy + sell ? (100 * buy) / (buy + sell) : null,
    delta15: lastN(15),
    delta30: lastN(30),
    high: Math.max(...candles.map((c) => c.high)),
    low: Math.min(...candles.map((c) => c.low)),
    lastTime: hhmm(last),
  };
}

/** Price range, cumulative delta and per-minute delta — three panels sharing one time axis and one crosshair. */
export function FlowCharts({ candles, zones = [], symbol = 'NIFTY' }) {
  const [box, W] = useWidth();
  const { tip, show, hide } = useTooltip();
  const [hover, setHover] = useState(null);
  const padL = 56;
  const padR = 8;
  const n = candles.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const barW = Math.max(1, Math.min(6, (W - padL - padR) / Math.max(1, n) - 1));

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1))));
    const c = candles[i];
    setHover(i);
    show(e, c.time.slice(11, 16), [
      ['High / Low', `${fmt(c.high, 1)} / ${fmt(c.low, 1)}`],
      ['Buy qty', fmtQty(c.buy_volume)],
      ['Sell qty', fmtQty(c.sell_volume)],
      ['Delta', signedQty(c.delta)],
      ['Cumulative delta', signedQty(c.cumulative_delta)],
    ]);
  };
  const onLeave = () => {
    setHover(null);
    hide();
  };

  const panel = (H, lo, hi, draw, ticks, zero) => {
    const y = (v) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', overflow: 'visible' }} onMouseMove={onMove} onMouseLeave={onLeave}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">{Math.abs(hi - lo) > 2000 || Math.abs(t) >= 1000 ? fmtQty(t) : fmt(t)}</text>
          </g>
        ))}
        {zero != null && <line x1={padL} x2={W - padR} y1={y(zero)} y2={y(zero)} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        {draw(y)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--text-muted)" />}
      </svg>
    );
  };

  const dayLo = Math.min(...candles.map((c) => c.low));
  const dayHi = Math.max(...candles.map((c) => c.high));
  // show zones that sit within ~1/3 of the day's range beyond its extremes
  const pad = Math.max(20, (dayHi - dayLo) / 3);
  const shownZones = zones.filter((z) => z.high >= dayLo - pad && z.low <= dayHi + pad);
  const pLo = Math.min(dayLo, ...shownZones.map((z) => z.low));
  const pHi = Math.max(dayHi, ...shownZones.map((z) => z.high));
  const cds = candles.map((c) => c.cumulative_delta);
  const cLo = Math.min(0, ...cds);
  const cHi = Math.max(0, ...cds);
  const dMax = Math.max(1, ...candles.map((c) => Math.abs(c.delta)));

  return (
    <div ref={box}>
      <div className="muted small">
        {symbol} future — price range per minute{shownZones.length ? ' · shaded: order-flow zones (red = supply, blue = demand)' : ''}
      </div>
      {panel(
        150,
        pLo - 2,
        pHi + 2,
        (y) => (
          <>
            {shownZones.map((z) => (
              <g key={`${z.low}-${z.high}`}>
                <rect x={padL} width={W - padL - padR} y={y(z.high)} height={Math.max(2, y(z.low) - y(z.high))} fill={z.origin === 'supply' ? 'var(--sell)' : 'var(--buy)'} opacity="0.14" />
                <text x={W - padR - 4} y={y(z.high) - 3} textAnchor="end">
                  {z.role === 'support' ? 'S' : z.role === 'resistance' ? 'R' : '•'} {fmt(z.low)}–{fmt(z.high)}
                </text>
              </g>
            ))}
            {candles.map((c, i) => <line key={c.t} x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke="var(--text-secondary)" strokeWidth={barW} strokeLinecap="round" />)}
          </>
        ),
        [pLo, (pLo + pHi) / 2, pHi],
      )}
      <div className="muted small" style={{ marginTop: 10 }}>Cumulative delta (buy − sell qty since the first minute)</div>
      {panel(
        120,
        cLo,
        cHi,
        (y) => (
          <path d={candles.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c.cumulative_delta).toFixed(1)}`).join('')} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        ),
        [cLo, cHi],
        0,
      )}
      <div className="muted small" style={{ marginTop: 10 }}>Delta per minute</div>
      {panel(
        100,
        -dMax,
        dMax,
        (y) =>
          candles.map((c, i) => (
            <line key={c.t} x1={x(i)} x2={x(i)} y1={y(0)} y2={y(c.delta)} stroke={c.delta >= 0 ? 'var(--buy)' : 'var(--sell)'} strokeWidth={barW} />
          )),
        [-dMax, dMax],
        0,
      )}
      <div className="muted small" style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: padL }}>
        <span>{hhmm(candles[0])}</span>
        <span>{hhmm(candles.at(-1))}</span>
      </div>
      {tip}
    </div>
  );
}

/** Day volume profile: buy vs sell quantity per price bucket, with the point of control (most traded bucket). */
export function VolumeProfile({ candles, bucket = 5, rows = 40 }) {
  const { tip, show, hide } = useTooltip();
  const profile = useMemo(() => {
    const m = new Map();
    for (const c of candles)
      for (const l of c.levels ?? []) {
        const b = Math.floor(l.price / bucket) * bucket;
        const e = m.get(b) ?? { price: b, buy: 0, sell: 0 };
        e.buy += l.buy_volume ?? 0;
        e.sell += l.sell_volume ?? 0;
        m.set(b, e);
      }
    return [...m.values()].sort((a, b) => b.price - a.price);
  }, [candles, bucket]);

  if (!profile.length) return <p className="muted">No price-level data yet.</p>;
  // keep the busiest window of `rows` buckets around the point of control
  const poc = profile.reduce((a, b) => (b.buy + b.sell > a.buy + a.sell ? b : a));
  const pocIdx = profile.indexOf(poc);
  const start = Math.max(0, Math.min(profile.length - rows, pocIdx - Math.floor(rows / 2)));
  const shown = profile.slice(start, start + rows);
  const max = Math.max(...shown.map((p) => p.buy + p.sell));
  const lastPrice = candles.at(-1)?.levels?.at(-1)?.price ?? null;

  return (
    <div>
      <div className="oi-legend">
        <span><span className="dot" style={{ background: 'var(--buy)' }} /> Buy qty</span>
        <span><span className="dot" style={{ background: 'var(--sell)' }} /> Sell qty</span>
        <span className="muted">POC (most traded) {fmt(poc.price)}–{fmt(poc.price + bucket)} · {bucket}-pt buckets</span>
      </div>
      {shown.map((p) => {
        const isPoc = p === poc;
        const holdsLast = lastPrice != null && lastPrice >= p.price && lastPrice < p.price + bucket;
        return (
          <div
            key={p.price}
            className={`vp-row${isPoc ? ' poc' : ''}`}
            onMouseMove={(e) =>
              show(e, `${fmt(p.price)}–${fmt(p.price + bucket)}`, [
                ['Buy qty', fmtQty(p.buy)],
                ['Sell qty', fmtQty(p.sell)],
                ['Delta', signedQty(p.buy - p.sell)],
              ])
            }
            onMouseLeave={hide}
          >
            <span className="vp-price">
              {fmt(p.price)}
              {holdsLast ? ' ◂' : ''}
            </span>
            <span className="vp-bar">
              <span style={{ width: `${(p.buy / max) * 100}%`, background: 'var(--buy)' }} />
              <span style={{ width: `${(p.sell / max) * 100}%`, background: 'var(--sell)' }} />
            </span>
            <span className="vp-delta">{signedQty(p.buy - p.sell)}</span>
          </div>
        );
      })}
      {tip}
    </div>
  );
}

/** Minutes with the strongest one-sided aggression (largest |delta|). */
export function AggressiveMinutes({ candles, n = 10 }) {
  const top = [...candles].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th><th>Side</th><th>Delta</th><th>Buy</th><th>Sell</th><th>Imbalance</th><th>High</th><th>Low</th>
          </tr>
        </thead>
        <tbody>
          {top.map((c) => (
            <tr key={c.t}>
              <td>{hhmm(c)}</td>
              <td><span className="act" style={{ color: c.delta >= 0 ? 'var(--buy)' : 'var(--sell)' }}>{c.delta >= 0 ? 'Buyers' : 'Sellers'}</span></td>
              <td><b>{signedQty(c.delta)}</b></td>
              <td>{fmtQty(c.buy_volume)}</td>
              <td>{fmtQty(c.sell_volume)}</td>
              <td>{c.total_volume ? `${Math.round((100 * Math.abs(c.delta)) / c.total_volume)}%` : '–'}</td>
              <td>{fmt(c.high, 1)}</td>
              <td>{fmt(c.low, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE = {
  breakout: 'var(--buy)',
  'failed breakdown': 'var(--buy)',
  held: 'var(--buy)',
  breakdown: 'var(--sell)',
  'failed breakout': 'var(--sell)',
  rejected: 'var(--sell)',
  absorbed: '#7a5af5', // violet: reversal by absorption (readable on light and dark)
  testing: 'var(--warning)',
  'closed in zone': 'var(--text-secondary)',
  'weak breakout': 'var(--text-secondary)',
  'weak breakdown': 'var(--text-secondary)',
};

/** Live read of zones tested today. */
export function ZoneWatch({ zones }) {
  const tested = zones.filter((z) => z.test).sort((a, b) => b.test.lastTouch.localeCompare(a.test.lastTouch));
  if (!tested.length) return <p className="muted">No zone was tested on this day yet. When price reaches one, its read appears here (live: every minute).</p>;
  return (
    <ul className="alerts">
      {tested.map((z) => (
        <li key={`${z.low}-${z.high}`}>
          <span className="tag" style={{ background: STATUS_TONE[z.test.status] ?? 'var(--text-secondary)', color: z.test.status === 'testing' ? '#000' : '#fff' }}>
            {z.test.status}
          </span>
          <span>
            <b>
              {z.test.role} {fmt(z.low)}–{fmt(z.high)}
            </b>{' '}
            · {z.test.read}
            <span className="muted">
              {' '}
              — {z.test.since.slice(11, 16)}–{z.test.lastTouch.slice(11, 16)}, delta {signedQty(z.test.delta)} ({z.test.imbalance > 0 ? '+' : ''}
              {z.test.imbalance}% imbalance){z.test.lastClose != null ? `, last 15-min close ${fmt(z.test.lastClose, 1)}` : ''}
            </span>
            {z.test.statusSince && (
              <span className="small" style={{ display: 'block', marginTop: 4 }}>
                <b>{z.test.status} since {z.test.statusSince.slice(11, 16)}</b>
                {z.test.history?.length > 1 && (
                  <span className="muted">
                    {' '}
                    · {z.test.history.map((h) => `${h.status} ${h.at.slice(11, 16)}`).join(' → ')}
                  </span>
                )}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** All zones near price, strongest first by position. */
export function ZonesTable({ zones }) {
  const max = Math.max(1, ...zones.map((z) => z.strength));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Zone</th><th>Acts as</th><th>Built by</th><th>Strength</th><th>Events</th><th>Last formed</th><th>Distance</th><th>Today</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => (
            <tr key={`${z.low}-${z.high}`}>
              <td>
                <b>
                  {fmt(z.low, z.low % 1 ? 1 : 0)}–{fmt(z.high, z.high % 1 ? 1 : 0)}
                </b>
              </td>
              <td style={{ color: z.role === 'resistance' ? 'var(--sell)' : z.role === 'support' ? 'var(--buy)' : 'var(--warning)' }}>{z.role}</td>
              <td>
                <span className="act">{z.origin === 'supply' ? 'sellers (supply)' : 'buyers (demand)'}</span>
              </td>
              <td>
                <span className="safety">
                  {fmtQty(z.strength)}
                  <span className="bar">
                    <div style={{ width: `${(z.strength / max) * 100}%` }} />
                  </span>
                </span>
              </td>
              <td>
                {z.events} in {z.days.length}d
              </td>
              <td>
                {z.lastEvent.day.slice(5)} · {z.lastEvent.kind}
              </td>
              <td>{z.distance ? `${z.distance} pts` : 'at price'}</td>
              <td>{z.test ? <span style={{ color: STATUS_TONE[z.test.status] }}>{z.test.status}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
