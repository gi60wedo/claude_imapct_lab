import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Brief, Candidate, Scenario, SimulationResult, TimeSlice } from '../../contracts';
import { gini } from '../../sim/metrics';
import type { CameraMode, Quality } from '../three/CityThree';
import { KIND_LABEL, PERSONAS, SCENARIO_LABEL, failingPersona, sliceParts, type Ranked } from './model';
import {
  dominantSurface, SLOPE_QUANTILE, STREET_RADIUS_M, SURFACE_GROUPS, type StreetStats,
} from './streetStats';
import { Accent, B, Card, CollapseButton, DASH, Delta, Kpi, Label, pct, Spark, StackBar, Tile } from './ui';

function Logo() {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_18px_rgba(34,211,238,0.35)]">
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-white stroke-2" aria-hidden="true">
        <path d="M12 2 3 7v10l9 5 9-5V7z M3 7l9 5 9-5 M12 12v10" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** "p90" with the quantile bound to its source constant. */
export function Quantile() {
  return <>p<B k="SLOPE_QUANTILE">{SLOPE_QUANTILE * 100}</B></>;
}

/** Parts for the stacked surface bar, in legend order. */
export const surfaceParts = (s: StreetStats) =>
  SURFACE_GROUPS.map((g) => ({ k: `streetStats.mix.${g.id}`, share: s.mix[g.id], className: g.className, label: g.label }));

/** Slope difference to the rival benchmark in percentage points, or null when either side is missing. */
export function slopeDelta(streets: StreetStats | null, rival: StreetStats | null | undefined): number | null {
  return streets?.meanSlope != null && rival?.meanSlope != null ? (streets.meanSlope - rival.meanSlope) * 100 : null;
}

export interface RivalStreets { name: string; streets: StreetStats | null }

export function TopBar({ result, scenario, slice, streets, rival }: {
  result: SimulationResult | null; scenario: Scenario; slice: TimeSlice;
  /** Street stats around the selected site, null while graph.json loads. */
  streets: StreetStats | null;
  /** The rival benchmark, for the slope delta. */
  rival: RivalStreets | null;
}) {
  const stalls = result?.stallExposure ?? [];
  const g = stalls.length ? gini(stalls) : null;
  const dominant = streets && dominantSurface(streets);
  const group = dominant ? SURFACE_GROUPS.find((x) => x.id === dominant) : undefined;
  const { clock, phase } = sliceParts(slice);
  return (
    <Card className="pointer-events-auto flex items-center gap-3 px-3 py-2" testId="three-topbar">
      <Logo />
      <div className="min-w-0 shrink">
        <h1 className="truncate text-lg font-bold tracking-tight">UrbanTwin: Market-Sim</h1>
        <span className="text-sm text-cyan-300">Topography &amp; Road Engine</span>
      </div>
      <div className="flex-1" />
      <div className="grid grid-cols-[repeat(4,minmax(0,13.5rem))] gap-2" data-testid="stat-chips">
        <Kpi label="Stalls evaluated" testId="kpi-stalls"
          chart={<Spark k="sort(result.stallExposure)" values={[...stalls].sort((a, b) => b - a)} />}
          sub={g === null ? undefined : <>fairness Gini <B k="gini(result.stallExposure)">{g.toFixed(2)}</B></>}>
          <B k="result.stallExposure.length">{result?.stallExposure.length}</B>
          <span className="font-sans text-sm font-normal text-zinc-400"> stall slots</span>
        </Kpi>
        <Kpi label="Street slope" testId="kpi-slope"
          sub={streets ? <><Quantile /> <B k="streetStats.p90Slope">{pct(streets.p90Slope)}</B> %{' '}
            <Delta k="streetStats.meanSlope − rival.streetStats.meanSlope" value={slopeDelta(streets, rival?.streets)} digits={1} unit=" pp"
              higherIsBetter={false} vs={rival?.name} /></> : undefined}>
          <B k="streetStats.meanSlope">{streets ? pct(streets.meanSlope) : DASH}</B>
          {streets?.meanSlope != null && <span className="font-sans text-sm font-normal text-zinc-400"> % mean</span>}
        </Kpi>
        <Kpi label="Surface model" testId="kpi-surface"
          chart={streets && streets.lengthM > 0 ? <StackBar parts={surfaceParts(streets)} testId="surface-bar" /> : undefined}
          sub={streets ? <>footways within <B k="STREET_RADIUS_M">{STREET_RADIUS_M}</B> m</> : undefined}>
          {group && streets ? (
            <><B k={`streetStats.mix.${group.id}`}>{pct(streets.mix[group.id], 0)}</B>
              <span className="font-sans text-sm font-normal text-zinc-300"> % {group.label.toLowerCase()}</span></>
          ) : <B k="streetStats.mix">{DASH}</B>}
        </Kpi>
        <Kpi label="Simulation day" testId="kpi-day" sub={SCENARIO_LABEL[scenario]}>
          <B k="slice">{clock}</B> <span className="font-sans text-sm font-normal text-cyan-300">{phase}</span>
        </Kpi>
      </div>
    </Card>
  );
}

export function CandidateList({ ranked, selectedId, brief, scenario, onSelect }: {
  ranked: Ranked[]; selectedId: string | null; brief: Brief | null; scenario: Scenario; onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  // Keep the selected card in view: boot selects the brief's pick, which can sit low in the list.
  useEffect(() => {
    const ol = list.current;
    const item = ol?.querySelector<HTMLElement>('[aria-pressed=true]')?.closest('li');
    if (!ol || !item) return;
    const top = item.offsetTop, bottom = top + item.offsetHeight;
    if (top < ol.scrollTop || bottom > ol.scrollTop + ol.clientHeight) {
      ol.scrollTop = Math.max(0, top - (ol.clientHeight - item.offsetHeight) / 2);
    }
  }, [selectedId, ranked.length, open]);
  return (
    <Card className="pointer-events-auto flex min-h-0 flex-col p-2.5" testId="candidate-list">
      <div className="flex shrink-0 items-start justify-between gap-2 px-1">
        <Label><B k="ranked.length">{ranked.length}</B> relocation candidates</Label>
        <div className="flex items-center gap-1">
          <Accent className="text-right">{SCENARIO_LABEL[scenario]}</Accent>
          <CollapseButton open={open} onToggle={() => setOpen((o) => !o)} testId="candidates-collapse" label="candidates" />
        </div>
      </div>
      <ol ref={list} className={`relative mt-2 min-h-0 flex-col gap-1.5 overflow-y-auto scroll-smooth pr-0.5 ${open ? 'flex' : 'hidden'}`}
        data-testid="candidate-scroll">
        {ranked.map(({ candidate: c, result, score, rank }, i) => {
          const selected = c.id === selectedId;
          const fail = failingPersona(result);
          const failLabel = fail && PERSONAS.find((p) => p.id === fail.id)!.label;
          const winner = brief?.recommended === c.id;
          return (
            <li key={c.id}>
              <button
                type="button" data-testid="candidate-card" data-candidate={c.id} aria-pressed={selected}
                onClick={() => onSelect(c.id)}
                className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${selected
                  ? 'border-cyan-300/60 bg-cyan-300/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_16px_rgba(34,211,238,0.15)]'
                  : 'border-white/[0.06] bg-white/[0.03] hover:border-white/25'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-semibold uppercase tracking-wide ${fail ? 'text-rose-300' : 'text-cyan-300'}`}>
                    Candidate {String.fromCharCode(65 + i)}{winner && ' · recommended'}
                  </span>
                  {selected && <span className="text-sm font-semibold uppercase text-white" data-testid="candidate-viewing">● Viewing</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span data-bind="candidate.name" className="truncate text-base font-semibold">{c.name}</span>
                  {fail ? (
                    <span className="shrink-0 rounded-lg border border-rose-400/50 bg-rose-500/10 px-1.5 text-sm text-rose-200" data-testid="fail-chip">
                      ⚠ <B k={`result.personas.${fail.id}.score`}>{fail.score}</B> {failLabel}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-1.5 text-sm text-cyan-200">
                      #<B k="rank">{rank}</B> · <B k="marketScore">{score.toFixed(1)}</B>
                    </span>
                  )}
                </div>
                <div className="truncate text-sm text-zinc-400">
                  {KIND_LABEL[c.kind]} · transit <B k="indicators.transitScore">{c.indicators.transitScore}</B>
                  {' '}· walk <B k="indicators.walkScore">{c.indicators.walkScore}</B>
                  {fail && <> · rank #<B k="rank">{rank}</B></>}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

const MODES: { mode: CameraMode; label: string; aria: string }[] = [
  // Labels avoid digits so the rule-zero audit stays strict; the aria label keeps the full name.
  { mode: 'perspective', label: 'Perspective', aria: 'Perspective 3D' },
  { mode: 'side', label: 'Side Slope', aria: 'Side Slope View' },
  { mode: 'top', label: 'Top-Down', aria: 'Top-Down Grid' },
];

export function CameraSwitch({ mode, heatmap, onMode, onHeatmap, quality, onQuality, streets, onStreets }: {
  mode: CameraMode; heatmap: boolean; onMode: (m: CameraMode) => void; onHeatmap: () => void;
  quality?: Quality; onQuality?: () => void; streets?: boolean; onStreets?: () => void;
}) {
  const base = 'rounded-xl border px-3 py-1 text-sm font-semibold transition';
  const on = 'border-cyan-300/50 bg-cyan-300/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]';
  const off = 'border-transparent text-zinc-300 hover:text-white';
  return (
    <Card className="flex flex-wrap items-center justify-center gap-0.5 p-1" testId="camera-switch">
      {MODES.map((m) => (
        <button key={m.mode} type="button" data-testid={`camera-${m.mode}`} aria-label={m.aria} aria-pressed={mode === m.mode}
          onClick={() => onMode(m.mode)} className={`${base} ${mode === m.mode ? on : off}`}>
          {m.label}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />
      <button type="button" data-testid="heatmap-toggle" aria-pressed={heatmap} onClick={onHeatmap}
        className={`${base} ${heatmap ? on : off}`}>
        Heatmap: {heatmap ? 'ON' : 'OFF'}
      </button>
      {onStreets && (
        <button type="button" data-testid="streets-toggle" aria-pressed={streets} onClick={onStreets}
          className={`${base} ${streets ? on : off}`}>
          Streets: {streets ? 'ON' : 'OFF'}
        </button>
      )}
      {onQuality && (
        <button type="button" data-testid="quality-toggle" aria-pressed={quality === 'high'} onClick={onQuality}
          aria-label={`Render quality ${quality === 'high' ? 'High' : 'Fast'}`}
          className={`${base} ${quality === 'high' ? on : off}`}>
          Quality: {quality === 'high' ? 'High' : 'Fast'}
        </button>
      )}
    </Card>
  );
}

function Cell({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Tile className="px-2.5 py-2" testId={testId}>
      <Label className="font-medium">{label}</Label>
      <div className="mt-1 text-sm">{children}</div>
    </Tile>
  );
}

export function ProfileCard({ candidate, result, streets, rival }: {
  candidate: Candidate | undefined; result: SimulationResult | null; streets: StreetStats | null; rival: RivalStreets | null;
}) {
  const g = result && result.stallExposure.length ? gini(result.stallExposure) : null;
  return (
    <Card className="p-3" testId="profile-card">
      <Accent className="mb-2">Road &amp; elevation profile</Accent>
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Terrain slope" testId="profile-slope">
          <div className="font-mono text-lg font-semibold text-zinc-50">
            <B k="streetStats.meanSlope">{streets ? pct(streets.meanSlope) : DASH}</B>
            {streets?.meanSlope != null && <span className="font-sans text-sm font-normal text-zinc-400"> % mean</span>}
          </div>
          {streets && (
            <div className="text-zinc-400">
              <Quantile /> <B k="streetStats.p90Slope" className="text-zinc-100">{pct(streets.p90Slope)}</B> %
              <div><Delta k="streetStats.meanSlope − rival.streetStats.meanSlope" value={slopeDelta(streets, rival?.streets)} digits={1} unit=" pp"
                higherIsBetter={false} vs={rival?.name} /></div>
            </div>
          )}
          {result && <div className="text-zinc-400">walkability <B k="result.criteria.walkability">{result.criteria.walkability}</B></div>}
        </Cell>
        <Cell label="Surface material" testId="profile-surface">
          {streets && streets.lengthM > 0 ? (
            <>
              <StackBar parts={surfaceParts(streets)} testId="profile-surface-bar" />
              <ul className="mt-1.5 flex flex-col gap-px text-zinc-300">
                {SURFACE_GROUPS.map((s) => (
                  <li key={s.id} className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-sm ${s.className}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <B k={`streetStats.mix.${s.id}`}>{pct(streets.mix[s.id], 0)}</B>%
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-zinc-500">
                <B k="streetStats.lengthM">{Math.round(streets.lengthM)}</B> m of footways within <B k="STREET_RADIUS_M">{STREET_RADIUS_M}</B> m
              </div>
            </>
          ) : <B k="streetStats.mix">{DASH}</B>}
        </Cell>
        <Cell label="Vehicle access" testId="profile-vehicle">
          {candidate ? (
            <>
              <span className={candidate.indicators.deliveryAccess ? 'text-emerald-300' : 'text-rose-300'}>
                {candidate.indicators.deliveryAccess ? '✓ Van route' : '✗ No van route'}
              </span>
              <span className="text-zinc-400"> · van <B k="indicators.vanDistM">{candidate.indicators.vanDistM}</B> m</span>
              {streets && <div className="text-zinc-400">bollards nearby <B k="streetStats.bollards">{streets.bollards}</B></div>}
            </>
          ) : <B k="indicators.deliveryAccess">{DASH}</B>}
          {result && <div className="text-zinc-400"><B k="result.personas.vendor.topFriction" mono={false}>{result.personas.vendor.topFriction}</B></div>}
        </Cell>
        <Cell label="Fairness Gini" testId="profile-gini">
          <B k="gini(result.stallExposure)" className="text-lg font-semibold text-cyan-300">{g === null ? DASH : g.toFixed(2)}</B>
          {result && <div className="text-zinc-400">fairness <B k="result.criteria.fairness">{result.criteria.fairness}</B></div>}
          {result && <div className="text-zinc-400">senior: <B k="result.personas.senior.topFriction" mono={false}>{result.personas.senior.topFriction}</B></div>}
        </Cell>
      </div>
    </Card>
  );
}
