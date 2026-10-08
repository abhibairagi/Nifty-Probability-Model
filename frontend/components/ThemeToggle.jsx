'use client';

// System / Light / Dark switch. The choice lives in localStorage ("theme") and is applied as <html data-theme>;
// "system" removes the attribute so the OS setting (prefers-color-scheme) decides. The inline script in
// app/layout.js applies the saved choice before first paint, so there is no flash.

import { useEffect, useState } from 'react';

const KEY = 'theme';
const OPTIONS = [
  { value: 'system', label: 'System', icon: 'M3 5h18v11H3zM8 20h8M12 16v4' },
  { value: 'light', label: 'Light', icon: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { value: 'dark', label: 'Dark', icon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' },
];

export function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') root.dataset.theme = value;
  else delete root.dataset.theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    try {
      setTheme(localStorage.getItem(KEY) || 'system');
    } catch {}
  }, []);

  const choose = (value) => {
    setTheme(value);
    applyTheme(value);
    try {
      if (value === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {}
  };

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={theme === o.value} className={theme === o.value ? 'on' : ''} onClick={() => choose(o.value)} title={o.label}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={o.icon} />
          </svg>
          {o.label}
        </button>
      ))}
    </div>
  );
}
