'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** const { tip, show, hide } = useTooltip();  show(event, title, [[label, value], …]) */
export function useTooltip() {
  const [state, setState] = useState(null);
  const show = useCallback((e, title, rows) => setState({ x: e.clientX, y: e.clientY, title, rows }), []);
  const hide = useCallback(() => setState(null), []);
  return { tip: <Tooltip state={state} />, show, hide };
}

function Tooltip({ state }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(state.x + 14, window.innerWidth - r.width - 8),
      top: Math.min(state.y + 14, window.innerHeight - r.height - 8),
    });
  }, [state]);

  if (!state) return null;
  return (
    <div ref={ref} className="tooltip" style={pos}>
      <div className="t">{state.title}</div>
      {state.rows.map(([k, v]) => (
        <div className="row" key={k}>
          {k} <b>{v}</b>
        </div>
      ))}
    </div>
  );
}
