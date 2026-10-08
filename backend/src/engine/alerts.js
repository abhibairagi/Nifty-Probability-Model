// "Thesis breaking" alerts: things an option seller must know immediately.

import { ACTIONS } from './oiAnalyzer.js';
import { round } from './math.js';

const MIN_COVER_PCT = 2; // % of a wall's OI unwound within the recent window before it counts as "weakening"

export function buildAlerts({ curr, prevReport, levels, recentRows, em, step, bias }) {
  const alerts = [];
  const near = Math.max(0.35 * em, 2 * step);
  const recent = new Map(recentRows.map((r) => [r.strike, r]));

  const support = levels.supports[0];
  const resistance = levels.resistances[0];

  if (support) {
    const r = recent.get(support.strike)?.pe;
    if (r?.action === ACTIONS.SHORT_COVERING && r.dOiPct <= -MIN_COVER_PCT && curr.spot - support.strike < near)
      alerts.push({ level: 'critical', text: `Put writers covering at support ${support.strike} (OI ${round(r.dOiPct, 1)}%) with spot ${round(curr.spot - support.strike, 0)} pts above — support weakening.` });
    if (curr.spot < support.strike)
      alerts.push({ level: 'critical', text: `Spot broke below the biggest put wall ${support.strike}.` });
  }
  if (resistance) {
    const r = recent.get(resistance.strike)?.ce;
    if (r?.action === ACTIONS.SHORT_COVERING && r.dOiPct <= -MIN_COVER_PCT && resistance.strike - curr.spot < near)
      alerts.push({ level: 'critical', text: `Call writers covering at resistance ${resistance.strike} (OI ${round(r.dOiPct, 1)}%) with spot ${round(resistance.strike - curr.spot, 0)} pts below — resistance weakening.` });
    if (curr.spot > resistance.strike)
      alerts.push({ level: 'critical', text: `Spot broke above the biggest call wall ${resistance.strike}.` });
  }

  for (const r of recentRows) {
    for (const side of ['ce', 'pe']) {
      const leg = r[side];
      if (leg.dIv != null && leg.dIv > 2 && Math.abs(r.strike - curr.spot) < near)
        alerts.push({ level: 'warning', text: `${r.strike} ${side.toUpperCase()} IV jumped +${round(leg.dIv, 1)} in the last interval.` });
    }
  }

  if (prevReport) {
    const p = prevReport.levels;
    if (p?.support && support && p.support !== support.strike)
      alerts.push({ level: 'info', text: `Support migrated ${p.support} → ${support.strike}.` });
    if (p?.resistance && resistance && p.resistance !== resistance.strike)
      alerts.push({ level: 'info', text: `Resistance migrated ${p.resistance} → ${resistance.strike}.` });
    if (prevReport.dayBias?.label && bias && prevReport.dayBias.label !== bias.label)
      alerts.push({ level: 'warning', text: `Day bias changed: ${prevReport.dayBias.label} → ${bias.label}.` });
  }
  return alerts;
}
