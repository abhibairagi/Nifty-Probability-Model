'use client';

import { useEffect, useState } from 'react';
import PageGate from '@/components/PageGate';
import { LevelsCard } from '@/components/Cards';
import { OiChart } from '@/components/Charts';
import MultiStrikeOi from '@/components/MultiStrikeOi';

const TABS = [
  { key: 'strikes', label: 'OI by strike' },
  { key: 'multi', label: 'Multi-strike OI' },
];
const TAB_KEY = 'expiry-model:oi-tab';

export default function OiPage() {
  const [tab, setTab] = useState('strikes');
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab') ?? localStorage.getItem(TAB_KEY); // ?tab=multi links straight in
      if (TABS.some((x) => x.key === t)) setTab(t);
    } catch {}
  }, []);
  const choose = (t) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
  };

  return (
    <PageGate title="OI Analysis">
      {(r) => (
        <>
          <div className="tabs" role="tablist" aria-label="OI views">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => choose(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'strikes' ? (
            <>
              <LevelsCard levels={r.levels} />
              <OiChart report={r} />
            </>
          ) : (
            <MultiStrikeOi />
          )}
        </>
      )}
    </PageGate>
  );
}
