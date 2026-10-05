/** Gini coefficient of non-negative values: 0 = perfectly even, → 1 = one slot takes everything. */
export function gini(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let total = 0;
  let weighted = 0;
  sorted.forEach((v, i) => { total += v; weighted += (i + 1) * v; });
  if (total === 0) return 0;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export const round1 = (x: number) => Math.round(x * 10) / 10;

export function formatClock(tSec: number): string {
  const h = Math.floor(tSec / 3600);
  const m = Math.floor((tSec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
};
