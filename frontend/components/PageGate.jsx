'use client';

import { useData } from './DataProvider';

/** Renders children(report, ctx) once a report exists; otherwise a loading / empty / offline message. */
export default function PageGate({ title, children }) {
  const ctx = useData();
  const { state, report, date } = ctx;
  return (
    <>
      <h1 className="page-title">{title}</h1>
      {state === 'loading' && <p className="empty">Loading…</p>}
      {state === 'offline' && (
        <p className="empty">
          Can't reach the backend. Start it with <code>cd backend && npm start</code>.
        </p>
      )}
      {state === 'empty' && (
        <p className="empty">
          No {ctx.symbol} snapshots for <b>{date}</b> yet. Paste today's curl on the <a href="/session">Data Sessions</a> page
          (data arrives during market hours), or run <code>node scripts/simulate.js --symbol {ctx.symbol}</code> in the backend and
          pick session “sim”.
        </p>
      )}
      {state === 'ready' && report && children(report, ctx)}
    </>
  );
}
