'use client';

import PageGate from '@/components/PageGate';
import { useData } from '@/components/DataProvider';
import { Timeline } from '@/components/Charts';
import { biasColor, fmt, time } from '@/lib/format';

export default function TimelinePage() {
  const { status } = useData();
  return (
    <PageGate title="Timeline">
      {(r, { timeline }) => (
        <>
          <section className="card">
            <h2>Day bias and pulse through the session</h2>
            <Timeline points={timeline} symbol={r.symbol} />
          </section>
          <section className="card">
            <h2>Every reading <span className="muted small">— OI every {status?.pollMinutes ?? 1} min</span></h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th><th>Spot</th><th>VIX</th><th>IV used</th><th>Day bias</th><th>Bull / Neu / Bear</th><th>Pulse (9 min)</th><th>Sideways</th><th>Support</th><th>Resistance</th><th>Short PE</th><th>Short CE</th><th>Alerts</th>
                  </tr>
                </thead>
                <tbody>
                  {[...timeline].reverse().map((p) => (
                    <tr key={p.timestamp}>
                      <td>{time(p.timestamp)}</td>
                      <td>{fmt(p.spot, 1)}</td>
                      <td>{fmt(p.vix, 2)}</td>
                      <td>{fmt(p.atmIv, 1)}</td>
                      <td style={{ color: biasColor(p.dayScore), fontWeight: 600 }}>{p.dayLabel} ({p.dayScore > 0 ? '+' : ''}{p.dayScore})</td>
                      <td>{(p.dayProbabilities ?? p.probabilities).bullish} / {(p.dayProbabilities ?? p.probabilities).neutral} / {(p.dayProbabilities ?? p.probabilities).bearish}</td>
                      <td style={{ color: biasColor(p.score) }}>{p.label} ({p.score > 0 ? '+' : ''}{p.score})</td>
                      <td>{p.range}</td>
                      <td>{p.support ?? '–'}</td>
                      <td>{p.resistance ?? '–'}</td>
                      <td>{p.suggestedPe ?? '–'}</td>
                      <td>{p.suggestedCe ?? '–'}</td>
                      <td>{p.alerts || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </PageGate>
  );
}
