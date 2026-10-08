'use client';

import PageGate from '@/components/PageGate';
import { StrikeTable } from '@/components/Charts';

export default function StrikesPage() {
  return (
    <PageGate title="Strike Probabilities">
      {(r) => (
        <>
          {!r.market.hasPremiums && (
            <p className="note warn">
              This feed has OI only (no option premiums or IV), so OI↑ is read as writing and OI↓ as covering, and every strike uses ATM IV {r.market.atmIv}% ({r.market.ivSource}).
            </p>
          )}
          <div className="stack-col">
            <StrikeTable title="Call side (CE) — probability of expiring OTM" rows={r.strikes.ce} suggested={r.suggestions.ce} />
            <StrikeTable title="Put side (PE) — probability of expiring OTM" rows={r.strikes.pe} suggested={r.suggestions.pe} />
          </div>
          <p className="muted small footnote">
            Stat = lognormal probability from the strike's own IV. Probabilities are centred on the expiry forward ({r.market.forward ?? r.market.spot}). Adj = same, tilted toward the day bias
            (centre {r.strikes.tiltedSpot}). Safety blends Adj with seller behaviour at the strike (writing ↑, covering ↓,
            IV spike ↓). ★ = suggested short strike (≥ {r.suggestions.targetProb}% Adj). A statistical model, not a guarantee.
          </p>
        </>
      )}
    </PageGate>
  );
}
