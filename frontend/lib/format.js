export const fmt = (n, d = 0) =>
  n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Indian lakhs, e.g. 1250000 → "12.5L"; below a lakh in thousands, e.g. 13920 → "13.9K" */
export const fmtL = (n) => {
  if (n == null) return '–';
  if (Math.abs(n) < 1e5) return `${(n / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 })}K`;
  return `${(n / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`;
};

export const signed = (n, f = fmtL) => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));

export const time = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export const ACTION_LABEL = {
  writing: 'Writing',
  short_covering: 'Short covering',
  long_buildup: 'Long buildup',
  long_unwinding: 'Long unwinding',
  none: '—',
};

export const COMP_LABEL = {
  oiFlow: 'OI flow',
  price: 'Price action',
  pcr: 'PCR',
  walls: 'OI walls',
  orderFlow: 'Order flow',
  zones: 'Your S/R zones',
};

export const biasColor = (score) => (score > 11 ? 'var(--good)' : score < -11 ? 'var(--critical)' : 'var(--neutral)');
