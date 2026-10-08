// Strike-wise probability of expiring OTM + a seller-oriented safety score.
//
// statProb  : pure lognormal probability from the strike's own IV (what the option price implies)
// adjProb   : same, but spot is tilted toward the directional bias (score ±100 → ±tilt × expected move)
// safety    : 0–10 blend of adjProb with seller behaviour at that strike (writing helps, covering hurts, IV spike hurts)

import { probOtm, expectedMove, round, clamp } from './math.js';
import { ACTIONS } from './oiAnalyzer.js';

const SELLER_EFFECT = {
  [ACTIONS.WRITING]: 1,
  [ACTIONS.LONG_UNWINDING]: 0.3,
  [ACTIONS.NONE]: 0,
  [ACTIONS.LONG_BUILDUP]: -0.5,
  [ACTIONS.SHORT_COVERING]: -1,
};

export function strikeSafety(curr, { years, atmIvPct, biasScore, sessionRows, recentRows, tilt = 0.3, window }) {
  // the expiry's forward (from option prices) is the market's centre for settlement; fall back to spot
  const centre = curr.forward ?? curr.spot;
  const em = expectedMove(centre, atmIvPct, years);
  const tiltedSpot = centre + (biasScore / 100) * tilt * em;
  const session = new Map(sessionRows.map((r) => [r.strike, r]));
  const recent = new Map(recentRows.map((r) => [r.strike, r]));
  const maxOi = {
    ce: Math.max(1, ...curr.strikes.map((s) => s.ce.oi)),
    pe: Math.max(1, ...curr.strikes.map((s) => s.pe.oi)),
  };

  const out = { ce: [], pe: [] };
  for (const s of curr.strikes) {
    if (Math.abs(s.strike - curr.spot) > window) continue;
    for (const [side, type] of [['ce', 'CE'], ['pe', 'PE']]) {
      // only OTM side matters for selling
      if (type === 'CE' && s.strike < curr.spot) continue;
      if (type === 'PE' && s.strike > curr.spot) continue;
      const leg = s[side];
      const iv = leg.iv > 0 ? leg.iv : atmIvPct;
      const statProb = probOtm(type, centre, s.strike, iv, years);
      const adjProb = probOtm(type, tiltedSpot, s.strike, iv, years);

      const sess = session.get(s.strike)?.[side];
      const rec = recent.get(s.strike)?.[side];
      const wallStrength = leg.oi / maxOi[side]; // 0..1, relative to the biggest wall on that side
      const behaviour = 0.6 * (SELLER_EFFECT[sess?.action] ?? 0) + 0.4 * (SELLER_EFFECT[rec?.action] ?? 0);
      const sellerStrength = clamp(0.5 * wallStrength + 0.5 * (behaviour + 1) / 2, 0, 1);
      const ivPenalty = rec?.dIv > 1.5 ? 0.5 : 0;

      const safety = clamp(10 * (0.75 * adjProb + 0.25 * sellerStrength) - ivPenalty, 0, 10);
      out[side].push({
        strike: s.strike,
        type,
        distance: round(Math.abs(s.strike - curr.spot), 0),
        ltp: leg.ltp,
        iv: round(iv),
        oi: leg.oi,
        sessionDOi: sess?.dOi ?? 0,
        sessionAction: sess?.action ?? ACTIONS.NONE,
        recentAction: rec?.action ?? ACTIONS.NONE,
        statProbOtm: round(100 * statProb, 1),
        adjProbOtm: round(100 * adjProb, 1),
        sellerStrength: round(10 * sellerStrength, 1),
        safety: round(safety, 1),
      });
    }
  }
  out.ce.sort((a, b) => a.strike - b.strike);
  out.pe.sort((a, b) => b.strike - a.strike);
  return { expectedMove: round(em, 1), tiltedSpot: round(tiltedSpot, 1), ...out };
}

/** Nearest strike (most premium) that still meets the target OTM probability — the practical "short strike". */
export function suggestShortStrikes(safety, targetProb = 85) {
  const pick = (rows) => rows.find((r) => r.adjProbOtm >= targetProb && r.sessionAction !== ACTIONS.SHORT_COVERING) ?? null;
  return { ce: pick(safety.ce), pe: pick(safety.pe), targetProb };
}
