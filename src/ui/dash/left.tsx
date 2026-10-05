import { useEffect, useRef, type ReactNode } from 'react';
import type { Brief, Candidate, Scenario, SimulationResult, TimeSlice } from '../../contracts';
import { formatClock, gini } from '../../sim/metrics';
import type { CameraMode } from '../three/CityThree';
import { KIND_LABEL, PERSONAS, SCENARIO_LABEL, SLICE_IDS, failingPersona, sliceParts, type Ranked } from './model';
import { Accent, B, Card, DASH, Label } from './ui';

function Logo() {
  return (
    <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_18px_rgba(34,211,238,0.45)]">
      <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-white stroke-2" aria-hidden="true">
        <path d="M12 2 3 7v10l9 5 9-5V7z M3 7l9 5 9-5 M12 12v10" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col px-4">
      <span className="text-sm uppercase tracking-wider text-muted">{label}</span>
      <span className="text-base text-cyan-300">{children}</span>
    </div>
  );
}

export function TopBar({ result, scenario, slice }: { result: SimulationResult | null; scenario: Scenario; slice: TimeSlice }) {
  const cobble = result ? Object.values(result.bySlice).flatMap((s) => s.bottlenecks).filter((b) => b.type === 'COBBLESTONE_FRICTION').length : null;
  return (
    <header className="flex items-center gap-4 border-b border-cyan-400/10 px-5 py-3" data-testid="three-topbar">
      <Logo />
      <h1 className="text-xl font-bold tracking-tight">UrbanTwin: Market-Sim</h1>
      <span className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 py-0.5 text-sm text-cyan-300">Topography &amp; Road Engine</span>
      <div className="flex-1" />
      <div className="flex divide-x divide-border rounded-xl border border-border bg-surface/70 py-2" data-testid="stat-chips">
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
          {cobble !== null && <span className="text-sm text-muted"> · cobble hotspots <B k="bySlice.*.bottlenecks[COBBLESTONE_FRICTION].length">{cobble}</B></span>}
        </Chip>
        <Chip label="Simulation day">
          {SCENARIO_LABEL[scenario]} · <B k="slice">{sliceParts(slice).clock}</B> {sliceParts(slice).phase}
        </Chip>
      </div>
    </header>
  );
}

export function CandidateList({ ranked, selectedId, brief, scenario, onSelect }: {
  ranked: Ranked[]; selectedId: string | null; brief: Brief | null; scenario: Scenario; onSelect: (id: string) => void;
}) {
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
  }, [selectedId, ranked.length]);
  return (
    <Card className="pointer-events-auto flex min-h-0 w-[380px] flex-col p-4" testId="candidate-list">
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <Label><B k="ranked.length">{ranked.length}</B> competing relocation candidates</Label>
        <Accent className="text-right">Nuremberg · {SCENARIO_LABEL[scenario]}</Accent>
      </div>
      <ol ref={list} className="relative flex min-h-0 flex-col gap-2 overflow-y-auto scroll-smooth pr-1" data-testid="candidate-scroll">
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
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${selected
                  ? 'border-cyan-300 bg-cyan-400/15 shadow-[0_0_18px_rgba(34,211,238,0.35)] ring-1 ring-cyan-300/60'
                  : 'border-border bg-background/60 hover:border-cyan-400/40'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-semibold uppercase ${fail ? 'text-red-400' : 'text-cyan-300'}`}>
                    Candidate {String.fromCharCode(65 + i)}{winner && ' (recommended)'}
                  </span>
                  {selected && <span className="text-xs font-semibold uppercase tracking-wider text-cyan-200" data-testid="candidate-viewing">● Viewing</span>}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-base font-bold">{c.name}</span>
                  {fail ? (
                    <span className="shrink-0 rounded border border-red-400/60 bg-red-500/15 px-2 py-0.5 text-sm text-red-300" data-testid="fail-chip">
                      ⚠ <B k={`result.personas.${fail.id}.score`}>{fail.score}</B> {failLabel}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded border border-cyan-400/50 bg-cyan-400/10 px-2 py-0.5 text-sm text-cyan-300">
                      Rank #<B k="rank">{rank}</B> (<B k="marketScore">{score.toFixed(1)}</B>)
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted">
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
  { mode: 'side', label: 'Side Slope View', aria: 'Side Slope View' },
  { mode: 'top', label: 'Top-Down Grid', aria: 'Top-Down Grid' },
];

export function CameraSwitch({ mode, heatmap, onMode, onHeatmap }: {
  mode: CameraMode; heatmap: boolean; onMode: (m: CameraMode) => void; onHeatmap: () => void;
}) {
  const base = 'rounded-lg px-4 py-1.5 text-sm font-semibold transition';
  return (
    <Card className="flex gap-1 p-1.5" testId="camera-switch">
      {MODES.map((m) => (
        <button key={m.mode} type="button" data-testid={`camera-${m.mode}`} aria-label={m.aria} aria-pressed={mode === m.mode}
          onClick={() => onMode(m.mode)}
          className={`${base} ${mode === m.mode ? 'border border-cyan-400/70 bg-cyan-400/15 text-foreground' : 'border border-transparent text-muted hover:text-foreground'}`}>
          {m.label}
        </button>
      ))}
      <button type="button" data-testid="heatmap-toggle" aria-pressed={heatmap} onClick={onHeatmap}
        className={`${base} border ${heatmap ? 'border-vendor/60 bg-vendor/15 text-foreground' : 'border-transparent text-muted hover:text-foreground'}`}>
        Heatmap: {heatmap ? 'ON' : 'OFF'}
      </button>
    </Card>
  );
}

function Cell({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/70 p-3" data-testid={testId}>
      <Label className="font-normal">{label}</Label>
      <div className="mt-1 text-base">{children}</div>
    </div>
  );
}

export function ProfileCard({ candidate, result }: { candidate: Candidate | undefined; result: SimulationResult | null }) {
  const g = result && result.stallExposure.length ? gini(result.stallExposure) : null;
  return (
    <Card className="w-[440px] p-4" testId="profile-card">
      <Accent className="mb-3">Physical road &amp; elevation profile</Accent>
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Terrain slope" testId="profile-slope">
          {/* TODO(subagent): contract needs slope (mean route slope per site in SimulationResult) */}
          <B k="slope">{DASH}</B>
          {result && <div className="text-sm text-muted">walkability <B k="result.criteria.walkability">{result.criteria.walkability}</B></div>}
        </Cell>
        <Cell label="Surface material" testId="profile-surface">
          {/* TODO(subagent): contract needs surface (dominant surface material per site) */}
          <B k="surface">{DASH}</B>
          {result && <div className="text-sm text-muted">senior friction: <B k="result.personas.senior.topFriction" mono={false}>{result.personas.senior.topFriction}</B></div>}
        </Cell>
        <Cell label="Vehicle access" testId="profile-vehicle">
          {candidate ? (
            <>
              <span className={candidate.indicators.deliveryAccess ? 'text-emerald-300' : 'text-red-300'}>
                {candidate.indicators.deliveryAccess ? '✓ Van route' : '✗ No van route'}
              </span>
              <span className="text-muted"> · van <B k="indicators.vanDistM">{candidate.indicators.vanDistM}</B> m</span>
            </>
          ) : <B k="indicators.deliveryAccess">{DASH}</B>}
          {result && <div className="text-sm text-muted"><B k="result.personas.vendor.topFriction" mono={false}>{result.personas.vendor.topFriction}</B></div>}
        </Cell>
        <Cell label="Fairness Gini" testId="profile-gini">
          <B k="gini(result.stallExposure)" className="text-cyan-300">{g === null ? DASH : g.toFixed(2)}</B>
          {result && <div className="text-sm text-muted">fairness <B k="result.criteria.fairness">{result.criteria.fairness}</B></div>}
        </Cell>
      </div>
    </Card>
  );
}

export function TimeBar({ slice, timeSec, playing, result, onSlice, onPlay }: {
  slice: TimeSlice; timeSec: number; playing: boolean; result: SimulationResult | null;
  onSlice: (s: TimeSlice) => void; onPlay: () => void;
}) {
  return (
    <Card className="flex items-center gap-3 p-3" testId="time-bar">
      <Label className="w-28 shrink-0">Saturday schedule</Label>
      {SLICE_IDS.map((s) => {
        const { clock, phase } = sliceParts(s);
        const active = s === slice;
        const hot = result?.bySlice[s].bottlenecks.length;
        return (
          <button key={s} type="button" data-testid={`slice-${s}`} aria-pressed={active} onClick={() => onSlice(s)}
            className={`min-w-36 rounded-lg border px-4 py-1.5 text-center text-sm font-semibold ${active
              ? 'border-cyan-400/70 bg-cyan-400/15 text-foreground' : 'border-border bg-background/60 text-muted hover:text-foreground'}`}>
            <B k="slice">{clock}</B> {phase}
            {hot !== undefined && <div className="font-normal text-muted"><B k={`bySlice.${s}.bottlenecks.length`}>{hot}</B> bottlenecks</div>}
          </button>
        );
      })}
      <button type="button" data-testid="play" aria-pressed={playing} aria-label={playing ? 'Pause trips' : 'Play trips'} onClick={onPlay}
        className="rounded-lg border border-cyan-400/50 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-300 hover:bg-cyan-400/20">
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <div className="ml-auto text-right text-base text-cyan-300">
        <div>sim <B k="timeSec">{formatClock(timeSec)}</B></div>
        <div className="text-sm">
          <B k="result.trips.length">{result?.trips.length}</B> trips · <B k="result.stallExposure.length">{result?.stallExposure.length}</B> stalls live
        </div>
      </div>
    </Card>
  );
}
