import type { ReactNode } from 'react';

export const DASH = '—';

/**
 * Wraps a value that comes from the engine, the candidate list or the brief. `k` names its
 * source path; e2e/three.spec.ts checks every digit on screen sits inside one of these.
 */
export function B({ k, children, className = '', mono = true }: { k: string; children: ReactNode; className?: string; mono?: boolean }) {
  return <span data-bind={k} className={`${mono ? 'font-mono ' : ''}${className}`}>{children ?? DASH}</span>;
}

/** Frosted dark glass: translucent fill, faint light border, soft inner highlight on the top edge. */
export const GLASS = 'rounded-2xl border border-white/10 bg-[rgba(20,22,28,0.55)] backdrop-blur-xl backdrop-saturate-150 '
  + 'shadow-[inset_0_1px_0_rgba(255,255,255,0.09),inset_0_0_24px_rgba(255,255,255,0.025),0_12px_32px_rgba(0,0,0,0.45)]';

/** Compact glass panel floating over the city. */
export function Card({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <section data-testid={testId} className={`${GLASS} ${className}`}>{children}</section>;
}

/** Glass tile inside a panel: one level lighter than the panel, same highlight. */
export function Tile({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <div data-testid={testId}
      className={`rounded-xl border border-white/[0.07] bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${className}`}>
      {children}
    </div>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-sm font-semibold uppercase tracking-wide text-zinc-400 ${className}`}>{children}</div>;
}

export function Accent({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-sm font-semibold uppercase tracking-wide text-cyan-300 ${className}`}>{children}</div>;
}

/** KPI tile: small label, large monospace value, then an optional chart and a sub line. */
export function Kpi({ label, children, chart, sub, testId, className = '' }: {
  label: ReactNode; children: ReactNode; chart?: ReactNode; sub?: ReactNode; testId?: string; className?: string;
}) {
  return (
    <Tile className={`flex min-w-0 flex-col gap-1 px-3 py-2 ${className}`} testId={testId}>
      <Label className="truncate font-medium">{label}</Label>
      <div className="truncate font-mono text-xl font-semibold leading-tight text-zinc-50">{children}</div>
      {chart}
      {sub && <div className="truncate text-sm text-zinc-400">{sub}</div>}
    </Tile>
  );
}

/**
 * Signed difference against a reference site, green when it favours the selection. `k` names the
 * source of the difference; the value is rendered with `digits` decimals and an optional unit.
 */
export function Delta({ k, value, digits = 0, unit = '', higherIsBetter = true, vs }: {
  k: string; value: number | null; digits?: number; unit?: string; higherIsBetter?: boolean; vs?: string;
}) {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  const good = rounded === 0 ? null : (rounded > 0) === higherIsBetter;
  const tone = good === null ? 'text-zinc-400' : good ? 'text-emerald-300' : 'text-rose-300';
  return (
    <span className={`whitespace-nowrap text-sm ${tone}`} data-testid="delta">
      <B k={k}>{`${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(digits)}${unit}`}</B>
      {vs && <span className="text-zinc-500"> vs {vs}</span>}
    </span>
  );
}

/** Sparkline of a numeric series, scaled to its own range. Draws nothing for fewer than two points. */
export function Spark({ values, k, className = 'stroke-cyan-300' }: { values: number[]; k: string; className?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - lo) / span) * 20}`).join(' ');
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-5 w-full" aria-hidden="true" data-bind={k} data-testid="spark">
      <polyline points={pts} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className={className} />
    </svg>
  );
}

/** Horizontal meter for a 0..1 share. */
export function Meter({ share, className = 'bg-cyan-300' }: { share: number | null; className?: string }) {
  const w = share === null ? 0 : Math.max(0, Math.min(1, share)) * 100;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${w}%` }} />
    </div>
  );
}

/** Stacked bar of shares that sum to 1; each part carries its own source key. */
export function StackBar({ parts, testId }: { parts: { k: string; share: number; className: string; label: string }[]; testId?: string }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-white/10" data-testid={testId} role="img"
      aria-label={parts.map((p) => p.label).join(', ')}>
      {parts.map((p) => (
        <div key={p.k} data-bind={p.k} data-share={p.share} className={p.className} style={{ width: `${Math.max(0, p.share) * 100}%` }} />
      ))}
    </div>
  );
}

/** Percent with one decimal from a 0..1 fraction. */
export const pct = (f: number | null | undefined, digits = 1) => (f === null || f === undefined ? DASH : (f * 100).toFixed(digits));

/** Small square toggle that collapses or expands a panel. */
export function CollapseButton({ open, onToggle, testId, label, direction = 'down' }: {
  open: boolean; onToggle: () => void; testId: string; label: string; direction?: 'down' | 'right';
}) {
  const glyph = direction === 'right' ? (open ? '›' : '‹') : (open ? '▾' : '▸');
  return (
    <button type="button" data-testid={testId} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      onClick={onToggle}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-base leading-none text-zinc-400 hover:bg-white/10 hover:text-white">
      {glyph}
    </button>
  );
}
