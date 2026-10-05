import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Brief, Candidate, Scenario, SimulationResult, TimeSlice } from '../../contracts';
import { gini } from '../../sim/metrics';
import type { CameraMode, Quality } from '../three/CityThree';
import { KIND_LABEL, PERSONAS, SCENARIO_LABEL, failingPersona, sliceParts, type Ranked } from './model';
import { Accent, B, Card, CollapseButton, DASH, Label } from './ui';

function Logo() {
  return (
    <div className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-cyan-400 to-blue-600">
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-white stroke-2" aria-hidden="true">
        <path d="M12 2 3 7v10l9 5 9-5V7z M3 7l9 5 9-5 M12 12v10" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col px-3">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="text-xs text-cyan-300">{children}</span>
    </div>
  );
}

export function TopBar({ result, scenario, slice }: { result: SimulationResult | null; scenario: Scenario; slice: TimeSlice }) {
  const cobble = result ? Object.values(result.bySlice).flatMap((s) => s.bottlenecks).filter((b) => b.type === 'COBBLESTONE_FRICTION').length : null;
  return (
    <Card className="pointer-events-auto flex items-center gap-3 px-3 py-1.5" testId="three-topbar">
      <Logo />
      <h1 className="text-sm font-bold tracking-tight">UrbanTwin: Market-Sim</h1>
      <span className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2 py-px text-[11px] text-cyan-300">Topography &amp; Road Engine</span>
      <div className="flex-1" />
      <div className="flex divide-x divide-white/10" data-testid="stat-chips">
        <Chip label="Stalls evaluated">
          <B k="result.stallExposure.length">{result?.stallExposure.length}</B> stall slots
        </Chip>
        <Chip label="Street slope">
          {/* TODO(subagent): contract needs slope (mean route slope per site in SimulationResult) */}
          <B k="slope">{DASH}</B>
        </Chip>
        <Chip label="Surface model">
          {/* TODO(subagent): contract needs surface (dominant surface material per site) */}
          <B k="surface">{DASH}</B>
          {cobble !== null && <span className="text-zinc-500"> · cobble hotspots <B k="bySlice.*.bottlenecks[COBBLESTONE_FRICTION].length">{cobble}</B></span>}
        </Chip>
        <Chip label="Simulation day">
          {SCENARIO_LABEL[scenario]} · <B k="slice">{sliceParts(slice).clock}</B> {sliceParts(slice).phase}
        </Chip>
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
    <Card className="pointer-events-auto flex min-h-0 flex-col p-2" testId="candidate-list">
      <div className="flex shrink-0 items-start justify-between gap-2 px-1">
        <Label><B k="ranked.length">{ranked.length}</B> relocation candidates</Label>
        <div className="flex items-center gap-1">
          <Accent className="text-right">{SCENARIO_LABEL[scenario]}</Accent>
          <CollapseButton open={open} onToggle={() => setOpen((o) => !o)} testId="candidates-collapse" label="candidates" />
        </div>
      </div>
      <ol ref={list} className={`relative mt-1.5 min-h-0 flex-col gap-1 overflow-y-auto scroll-smooth pr-0.5 ${open ? 'flex' : 'hidden'}`}
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
                className={`w-full rounded-md border px-2 py-1.5 text-left transition ${selected
                  ? 'border-white/70 bg-white/10'
                  : 'border-white/5 bg-black/30 hover:border-white/25'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[11px] font-semibold uppercase ${fail ? 'text-red-400' : 'text-cyan-300'}`}>
                    Candidate {String.fromCharCode(65 + i)}{winner && ' · recommended'}
                  </span>
                  {selected && <span className="text-[10px] font-semibold uppercase tracking-wider text-white" data-testid="candidate-viewing">● Viewing</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{c.name}</span>
                  {fail ? (
                    <span className="shrink-0 rounded border border-red-400/50 bg-red-500/10 px-1.5 text-[11px] text-red-300" data-testid="fail-chip">
                      ⚠ <B k={`result.personas.${fail.id}.score`}>{fail.score}</B> {failLabel}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded border border-cyan-400/40 bg-cyan-400/10 px-1.5 text-[11px] text-cyan-300">
                      #<B k="rank">{rank}</B> · <B k="marketScore">{score.toFixed(1)}</B>
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-zinc-400">
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
  const base = 'rounded-md border px-2.5 py-1 text-xs font-semibold transition';
  const on = 'border-white/40 bg-white/10 text-white';
  const off = 'border-transparent text-zinc-400 hover:text-white';
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
    <div className="rounded-md border border-white/5 bg-black/30 px-2 py-1.5" data-testid={testId}>
      <Label className="font-normal">{label}</Label>
      <div className="mt-0.5 text-xs">{children}</div>
    </div>
  );
}

export function ProfileCard({ candidate, result }: { candidate: Candidate | undefined; result: SimulationResult | null }) {
  const g = result && result.stallExposure.length ? gini(result.stallExposure) : null;
  return (
    <Card className="p-2.5" testId="profile-card">
      <Accent className="mb-1.5">Road &amp; elevation profile</Accent>
      <div className="grid grid-cols-2 gap-1.5">
        <Cell label="Terrain slope" testId="profile-slope">
          {/* TODO(subagent): contract needs slope (mean route slope per site in SimulationResult) */}
          <B k="slope">{DASH}</B>
          {result && <div className="text-zinc-400">walkability <B k="result.criteria.walkability">{result.criteria.walkability}</B></div>}
        </Cell>
        <Cell label="Surface material" testId="profile-surface">
          {/* TODO(subagent): contract needs surface (dominant surface material per site) */}
          <B k="surface">{DASH}</B>
          {result && <div className="text-zinc-400">senior friction: <B k="result.personas.senior.topFriction" mono={false}>{result.personas.senior.topFriction}</B></div>}
        </Cell>
        <Cell label="Vehicle access" testId="profile-vehicle">
          {candidate ? (
            <>
              <span className={candidate.indicators.deliveryAccess ? 'text-emerald-300' : 'text-red-300'}>
                {candidate.indicators.deliveryAccess ? '✓ Van route' : '✗ No van route'}
              </span>
              <span className="text-zinc-400"> · van <B k="indicators.vanDistM">{candidate.indicators.vanDistM}</B> m</span>
            </>
          ) : <B k="indicators.deliveryAccess">{DASH}</B>}
          {result && <div className="text-zinc-400"><B k="result.personas.vendor.topFriction" mono={false}>{result.personas.vendor.topFriction}</B></div>}
        </Cell>
        <Cell label="Fairness Gini" testId="profile-gini">
          <B k="gini(result.stallExposure)" className="text-cyan-300">{g === null ? DASH : g.toFixed(2)}</B>
          {result && <div className="text-zinc-400">fairness <B k="result.criteria.fairness">{result.criteria.fairness}</B></div>}
        </Cell>
      </div>
    </Card>
  );
}
