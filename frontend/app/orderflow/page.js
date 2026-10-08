'use client';

// Order Flow tab — Dhan futures order flow for the instrument selected in the sidebar (NIFTY or SENSEX, each with its
// own Dhan session). Stand-alone: nothing on this page feeds the bias or probabilities.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useData } from '@/components/DataProvider';
import { AggressiveMinutes, FlowCharts, VolumeProfile, ZoneWatch, ZonesTable, fmtQty, summarize } from '@/components/OrderFlow';
import { fmt } from '@/lib/format';

const signed = (n) => (n > 0 ? '+' : '') + fmtQty(n);
const tone = (n) => (n > 0 ? 'var(--buy)' : n < 0 ? 'var(--sell)' : 'var(--text-primary)');

const weekday = (d) => new Date(`${d}T12:00:00+05:30`).getUTCDay();
const shift = (d, n) => new Date(new Date(`${d}T12:00:00+05:30`).getTime() + n * 86400e3).toISOString().slice(0, 10);
const pretty = (d) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** Previous / next weekday within [earliest, today]. */
function step(d, dir, { earliest, today }) {
  let x = d;
  do x = shift(x, dir);
  while ([0, 6].includes(weekday(x)) && x >= earliest && x <= today);
  return x < earliest || x > today ? d : x;
}

export default function OrderFlowPage() {
  const { q, symbol } = useData();
  const [range, setRange] = useState(null); // { today, earliest, stored }
  const [date, setDate] = useState(null);
  const [data, setData] = useState(null);
  const [zones, setZones] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api(q('/api/orderflow/dates'))
      .then((r) => {
        setRange(r);
        setDate((d) => d ?? r.today);
      })
      .catch((e) => setError(e.message));
  }, [q]);

  const load = useCallback(
    (showLoading = false) => {
      if (!date) return;
      if (showLoading) setLoading(true);
      Promise.all([api(q('/api/orderflow', { params: { date } })), api(q('/api/orderflow/zones', { params: { date } })).catch(() => null)])
        .then(([d, z]) => {
          setData(d);
          setZones(z);
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [date, q],
  );

  useEffect(() => {
    setData(null);
    setZones(null);
    load(true);
    // only today's data changes — refresh it every 30 s
    if (date && range && date === range.today) {
      const id = setInterval(() => load(false), 30_000);
      return () => clearInterval(id);
    }
  }, [load, date, range]);

  const isToday = range && date === range.today;
  const picker = range && date && (
    <div className="of-dates">
      <button type="button" onClick={() => setDate(step(date, -1, range))} disabled={date <= range.earliest} aria-label="Previous trading day">
        ◀
      </button>
      <input
        type="date"
        value={date}
        min={range.earliest}
        max={range.today}
        onChange={(e) => e.target.value && e.target.value >= range.earliest && e.target.value <= range.today && setDate(e.target.value)}
        aria-label="Order flow date"
      />
      <button type="button" onClick={() => setDate(step(date, 1, range))} disabled={date >= range.today} aria-label="Next trading day">
        ▶
      </button>
      <button type="button" onClick={() => setDate(range.today)} disabled={isToday}>
        Today
      </button>
      <span className="muted small">
        {pretty(date)} · last 30 days available{range.stored?.length ? ` · ${range.stored.length} days stored` : ''}
      </span>
    </div>
  );

  const candles = data?.candles ?? [];
  const s = summarize(candles);

  return (
    <>
      <h1 className="page-title">Order Flow</h1>
      {picker}
      <p className="note" style={{ margin: 0 }}>
        {symbol ?? 'NIFTY'} futures order flow from Dhan{data?.expiry ? ` (contract expiring ${data.expiry})` : ''}, refreshed every minute. Shown for reference only — it is
        <b> not</b> used in the day bias, probabilities or any other tab.
      </p>

      {error && <p className="empty">{error}</p>}
      {!error && loading && <p className="empty">Loading {date && pretty(date)}… (a day not stored yet is downloaded from Dhan once)</p>}
      {!error && !loading && !s && date && (
        <p className="empty">
          No order flow for <b>{pretty(date)}</b>.{' '}
          {[0, 6].includes(weekday(date))
            ? 'It is a weekend.'
            : isToday
              ? `Data arrives during market hours once the day’s ${symbol ?? 'NIFTY'} Dhan curl is saved in Settings.`
              : 'Probably a market holiday — or the Dhan session in Settings has expired.'}
        </p>
      )}

      {s && (
        <>
          <section className="kpis">
            <div className="kpi">
              <div className="label">Cumulative delta</div>
              <div className="value" style={{ color: tone(s.cumDelta) }}>{signed(s.cumDelta)}</div>
              <div className="sub">{s.cumDelta >= 0 ? 'net aggressive buying' : 'net aggressive selling'} {isToday ? 'since 09:15' : 'for the day'}</div>
            </div>
            <div className="kpi">
              <div className="label">Buy vs sell qty</div>
              <div className="value">{fmt(s.buyPct, 0)}% buy</div>
              <div className="sub">{fmtQty(s.buy)} bought · {fmtQty(s.sell)} sold</div>
            </div>
            <div className="kpi">
              <div className="label">Delta, last 15 min</div>
              <div className="value" style={{ color: tone(s.delta15) }}>{signed(s.delta15)}</div>
              <div className="sub">last 30 min {signed(s.delta30)}</div>
            </div>
            <div className="kpi">
              <div className="label">Day range (future)</div>
              <div className="value">{fmt(s.high - s.low, 1)} pts</div>
              <div className="sub">{fmt(s.low, 1)} – {fmt(s.high, 1)}</div>
            </div>
            <div className="kpi">
              <div className="label">Last minute</div>
              <div className="value">{s.lastTime}</div>
              <div className="sub">{candles.length} one-minute candles</div>
            </div>
          </section>

          {zones?.zones?.length > 0 && (
            <section className="card">
              <h2>
                Zone watch{' '}
                <span className="muted small">
                  — {isToday ? 'live read when price tests an order-flow zone' : `how zones were tested on ${pretty(date)}, using only the days before it`} (15-min closes from Kite)
                </span>
              </h2>
              <ZoneWatch zones={zones.zones} />
              <div className="kv" style={{ marginTop: 14 }}>
                <div>
                  <span>{isToday ? 'Futures price' : 'Futures close that day'}</span>
                  {fmt(zones.price, 1)}
                </div>
                <div>
                  <span>Nearest resistance</span>
                  {zones.nearestResistance ? `${fmt(zones.nearestResistance.low)}–${fmt(zones.nearestResistance.high)} (${zones.nearestResistance.distance} pts)` : '–'}
                </div>
                <div>
                  <span>Nearest support</span>
                  {zones.nearestSupport ? `${fmt(zones.nearestSupport.low)}–${fmt(zones.nearestSupport.high)} (${zones.nearestSupport.distance} pts)` : '–'}
                </div>
                <div>
                  <span>Built from</span>
                  {zones.days.length} days · {zones.aggressiveBars} aggressive 15-min bars
                </div>
              </div>
            </section>
          )}

          <section className="card">
            <h2>Price and delta through the day</h2>
            <FlowCharts symbol={symbol ?? 'NIFTY'} candles={candles} zones={zones?.date === data?.date ? zones?.zones ?? [] : []} />
          </section>

          {zones?.zones?.length > 0 && (
            <section className="card">
              <h2>
                Order-flow zones <span className="muted small">— where aggressive sellers / buyers acted on 15-min bars ({zones.days[0]} → {zones.days.at(-1)}), futures prices</span>
              </h2>
              <ZonesTable zones={zones.zones} />
              <p className="muted small" style={{ marginBottom: 0 }}>
                A zone forms where a 15-min bar had unusually large one-sided delta (top 15%, ≥ 20% imbalance): the price level where that selling or
                buying concentrated, or the bar extreme when the aggression was absorbed (heavy buying closing weak = sellers waiting above). Nearby levels
                merge (max 30 pts wide); newer days count more. A zone above price acts as resistance, below as support — whoever built it.
              </p>
            </section>
          )}

          <div className="grid two">
            <section className="card">
              <h2>Volume profile <span className="muted small">— where the day's buying and selling happened</span></h2>
              <VolumeProfile candles={candles} />
            </section>
            <section className="card">
              <h2>Most aggressive minutes <span className="muted small">— largest one-sided delta</span></h2>
              <AggressiveMinutes candles={candles} />
            </section>
          </div>
        </>
      )}
    </>
  );
}
