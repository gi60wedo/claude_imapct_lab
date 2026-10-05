import type { ReactNode } from 'react';

export const DASH = '—';

/**
 * Wraps a value that comes from the engine, the candidate list or the brief. `k` names its
 * source path; e2e/three.spec.ts checks every digit on screen sits inside one of these.
 */
export function B({ k, children, className = '', mono = true }: { k: string; children: ReactNode; className?: string; mono?: boolean }) {
  return <span data-bind={k} className={`${mono ? 'font-mono ' : ''}${className}`}>{children ?? DASH}</span>;
}

export function Card({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId}
      className={`rounded-xl border border-cyan-400/15 bg-surface/80 shadow-[0_0_24px_rgba(34,211,238,0.06)] backdrop-blur ${className}`}>
      {children}
    </section>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-sm font-semibold uppercase tracking-wider text-muted ${className}`}>{children}</div>;
}

export function Accent({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-sm font-semibold uppercase tracking-wider text-cyan-300 ${className}`}>{children}</div>;
}
