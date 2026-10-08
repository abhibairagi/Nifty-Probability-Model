'use client';

import PageGate from '@/components/PageGate';
import { AlertsCard, BiasCard, Kpis, LevelsCard, RangeCard } from '@/components/Cards';
import { time } from '@/lib/format';

export default function Overview() {
  return (
    <PageGate title="Overview">
      {(r) => (
        <>
          <Kpis report={r} />
          <div className="grid two">
            <BiasCard bias={r.dayBias} pulse={r.bias} since={time(r.sessionStart)} />
            <RangeCard report={r} />
          </div>
          <AlertsCard alerts={r.alerts} />
          <LevelsCard levels={r.levels} />
        </>
      )}
    </PageGate>
  );
}
