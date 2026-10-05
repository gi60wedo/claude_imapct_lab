import type { ReactNode } from 'react';

export const DASH = '—';

/**
 * Wraps a value that comes from the engine, the candidate list or the brief. `k` names its
 * source path; e2e/three.spec.ts checks every digit on screen sits inside one of these.
 */
export function B({ k, children, className = '', mono = true }: { k: string; children: ReactNode; className?: string; mono?: boolean }) {
  return <span data-bind={k} className={`${mono ? 'font-mono ' : ''}${className}`}>{children ?? DASH}</span>;
}

/** Compact dark glass panel floating over the city. */
export function Card({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId}
      className={`rounded-lg border border-white/10 bg-zinc-950/60 shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur-md ${className}`}>
      {children}
    </section>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-[11px] font-semibold uppercase tracking-wider text-zinc-400 ${className}`}>{children}</div>;
}

export function Accent({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-[11px] font-semibold uppercase tracking-wider text-cyan-300 ${className}`}>{children}</div>;
}

/** Small square toggle that collapses or expands a panel. */
export function CollapseButton({ open, onToggle, testId, label, direction = 'down' }: {
  open: boolean; onToggle: () => void; testId: string; label: string; direction?: 'down' | 'right';
}) {
  const glyph = direction === 'right' ? (open ? '›' : '‹') : (open ? '▾' : '▸');
  return (
    <button type="button" data-testid={testId} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      onClick={onToggle}
      className="grid h-5 w-5 shrink-0 place-items-center rounded text-sm leading-none text-zinc-400 hover:bg-white/10 hover:text-white">
      {glyph}
    </button>
  );
}
