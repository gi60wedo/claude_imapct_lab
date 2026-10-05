import { useState } from 'react';
import type { Brief, Candidate, SimulationResult, TimeSlice } from '../../contracts';
import { PERSONAS, briefLine, matchesSite, sliceParts, stallTone, type StallTone } from './model';
import { Accent, B, Card, DASH, Label } from './ui';

const R = 40;
const CIRC = 2 * Math.PI * R;

export function ScoreCard({ score, rank, of, candidate, brief }: {
  score: number | null; rank: number | null; of: number; candidate: Candidate | undefined; brief: Brief | null;
}) {
  const frac = score === null ? 0 : Math.max(0, Math.min(1, score / 100));
  const line = briefLine(brief, candidate);
  return (
    <Card className="flex items-center gap-3 p-2.5" testId="score-card">
      <svg viewBox="0 0 100 100" className="h-16 w-16 shrink-0 -rotate-90" role="img" aria-label="MarketScore">
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" className="stroke-white/10" />
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" strokeLinecap="round"
          className="stroke-cyan-400"
          strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - frac)} />
        <text x="50" y="47" textAnchor="middle" dominantBaseline="central" data-bind="marketScore"
          className="origin-center rotate-90 fill-foreground font-mono text-[24px] font-bold">
          {score === null ? DASH : score.toFixed(1)}
        </text>
        <text x="50" y="68" textAnchor="middle" className="origin-center rotate-90 fill-cyan-300 text-[14px] font-semibold">SCORE</text>
      </svg>
      <div className="min-w-0">
        <Accent>MarketScore{rank !== null && <> · rank #<B k="rank">{rank}</B> of <B k="ranked.length">{of}</B></>}</Accent>
        <p className="mt-0.5 line-clamp-3 text-xs leading-snug text-zinc-200">
          <B k={brief?.recommended === candidate?.id ? 'brief.why[0]' : 'brief.comparisons[site].betterAt'} mono={false}>{line ?? DASH}</B>
        </p>
      </div>
    </Card>
  );
}

const TONE: Record<StallTone, string> = {
  hot: 'border-vendor/60 bg-vendor/15 text-orange-200',
  even: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200',
  cold: 'border-white/5 bg-black/30 text-zinc-500',
};

export function StallGrid({ result }: { result: SimulationResult }) {
  const stalls = result.stallExposure;
  const mean = stalls.reduce((s, v) => s + v, 0) / stalls.length;
  const busiest = stalls.indexOf(Math.max(...stalls));
  const [picked, setPicked] = useState<number | null>(null);
  const sel = picked !== null && picked < stalls.length ? picked : busiest;
  return (
    <Card className="p-2.5" testId="stall-grid">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Label><B k="result.stallExposure.length">{stalls.length}</B> vendor stalls &amp; fairness</Label>
        <Accent>mean <B k="mean(result.stallExposure)">{mean.toFixed(0)}</B> visitors</Accent>
      </div>
      <div className="grid max-h-28 grid-cols-10 gap-1 overflow-y-auto pr-0.5">
        {stalls.map((v, i) => (
          <button key={i} type="button" data-testid="stall" aria-pressed={i === sel} onClick={() => setPicked(i)}
            title={`${v} visitors`}
            className={`rounded border py-0.5 text-center text-[11px] ${TONE[stallTone(v, mean)]} ${i === sel ? 'ring-1 ring-white' : ''}`}>
            <B k={`result.stallExposure[${i}].slot`}>{i + 1}</B>
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between rounded-md border border-white/5 bg-black/30 px-2 py-1.5" data-testid="stall-detail">
        <div>
          <div className="text-xs font-bold">Stall #<B k="stall.slot">{sel + 1}</B>{sel === busiest && ' · busiest slot'}</div>
          <div className="text-[11px] text-zinc-400">
            <B k="stall.exposure/mean">{mean > 0 ? (stalls[sel] / mean).toFixed(2) : DASH}</B>× layout mean · {stallTone(stalls[sel], mean)} flow
          </div>
        </div>
        <div className="text-sm text-cyan-300"><B k={`result.stallExposure[${sel}]`}>{stalls[sel]}</B> visitors</div>
      </div>
    </Card>
  );
}

export function PersonaCards({ result }: { result: SimulationResult | null }) {
  return (
    <Card className="p-2.5" testId="persona-cards">
      <div className="mb-1.5 flex items-center justify-between">
        <Label>Persona trade-offs</Label>
        <Accent>{result ? <>Engine · seed <B k="result.seed">{result.seed}</B></> : 'Engine'}</Accent>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {PERSONAS.map((p) => {
          const r = result?.personas[p.id];
          return (
            <div key={p.id} className="rounded-md border border-white/5 bg-black/30 px-2 py-1.5" data-testid={`persona-card-${p.id}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-xs font-bold ${p.text}`}>{p.label}</span>
                <B k={`result.personas.${p.id}.score`} className={`text-sm font-bold ${p.text}`}>{r?.score}</B>
              </div>
              <div className="mt-1 h-1 rounded-full bg-white/10">
                <div className={`h-full rounded-full ${p.bar}`} style={{ width: `${r ? Math.max(0, Math.min(100, r.score)) : 0}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-zinc-400">
                {p.who} · served <B k={`result.personas.${p.id}.served`}>{r?.served}</B> · dropped <B k={`result.personas.${p.id}.droppedOut`}>{r?.droppedOut}</B>
              </div>
              {r?.verdict && (
                <p className="mt-1 text-[11px] italic text-zinc-300">
                  <B k={`result.personas.${p.id}.verdict`} mono={false}>{r.verdict}</B>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function Constraints({ result, brief, candidate, slice }: {
  result: SimulationResult | null; brief: Brief | null; candidate: Candidate | undefined; slice: TimeSlice;
}) {
  const losers = brief?.losers ?? [];
  const cmp = candidate && brief ? brief.comparisons.find((c) => matchesSite(c.site, candidate)) : undefined;
  const worst = result ? [...result.bySlice[slice].bottlenecks].sort((a, b) => b.severity - a.severity)[0] : undefined;
  return (
    <Card className="p-2.5" testId="constraints">
      <div className="mb-1.5 flex items-center justify-between">
        <Label>Travel constraints</Label>
        <Accent>Specific drivers</Accent>
      </div>
      <ul className="flex flex-col gap-1 text-[11px]">
        {PERSONAS.map((p) => {
          const r = result?.personas[p.id];
          const fix = losers.find((l) => l.persona === p.id);
          return (
            <li key={p.id} className={`border-l-2 ${p.border} bg-black/30 py-1 pl-2 pr-1.5`} data-testid={`constraint-${p.id}`}>
              <span className={`font-bold ${p.text}`}>{p.label}:</span>{' '}
              <B k={`result.personas.${p.id}.topFriction`} mono={false}>{r?.topFriction}</B>
              {fix && <div className="text-zinc-400">Claude mitigation: <B k="brief.losers[persona].mitigation" mono={false}>{fix.mitigation}</B></div>}
            </li>
          );
        })}
        {worst && (
          <li className="border-l-2 border-red-400 bg-black/30 py-1 pl-2 pr-1.5" data-testid="constraint-bottleneck">
            <span className="font-bold text-red-300">Worst bottleneck at <B k="slice">{sliceParts(slice).clock}</B>:</span>{' '}
            <B k={`bySlice.${slice}.bottlenecks[maxSeverity].cause`} mono={false}>{worst.cause}</B>
            {' '}at <B k={`bySlice.${slice}.bottlenecks[maxSeverity].time`}>{worst.time}</B>, severity <B k={`bySlice.${slice}.bottlenecks[maxSeverity].severity`}>{worst.severity.toFixed(2)}</B>
          </li>
        )}
        {cmp && (
          <li className="border-l-2 border-cyan-400 bg-black/30 py-1 pl-2 pr-1.5" data-testid="constraint-brief">
            <span className="font-bold text-cyan-300">Brief:</span> better at <B k="brief.comparisons[site].betterAt" mono={false}>{cmp.betterAt}</B>;
            worse at <B k="brief.comparisons[site].worseAt" mono={false}>{cmp.worseAt}</B>
          </li>
        )}
        {brief && brief.recommended === candidate?.id && brief.why.map((w, i) => (
          <li key={i} className="border-l-2 border-cyan-400 bg-black/30 py-1 pl-2 pr-1.5" data-testid="constraint-brief">
            <span className="font-bold text-cyan-300">Why recommended:</span> <B k={`brief.why[${i}]`} mono={false}>{w}</B>
          </li>
        ))}
      </ul>
    </Card>
  );
}
