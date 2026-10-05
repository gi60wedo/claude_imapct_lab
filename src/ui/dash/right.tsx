import { useMemo, useState, type ReactNode } from 'react';
import type { Brief, Candidate, PersonaId, Scenario, SimulationResult, TimeSlice } from '../../contracts';
import {
  bindingBottleneck, budgetValue, BUDGETS, citizenChoice, countBottlenecks, servedShare, tripStats, type TripStats,
} from './citizens';
import { PERSONAS, briefLine, matchesSite, sliceParts, stallTone, type Ranked, type StallTone } from './model';
import { STREET_RADIUS_M, type StreetStats } from './streetStats';
import { Accent, B, Card, DASH, Delta, Label, Meter, pct, Tile } from './ui';

const R = 40;
const CIRC = 2 * Math.PI * R;

export function ScoreCard({ score, rank, of, candidate, brief, rival }: {
  score: number | null; rank: number | null; of: number; candidate: Candidate | undefined; brief: Brief | null;
  /** Best-ranked other benchmark, for the MarketScore delta. */
  rival: Ranked | null;
}) {
  const frac = score === null ? 0 : Math.max(0, Math.min(1, score / 100));
  const line = briefLine(brief, candidate);
  return (
    <Card className="flex items-center gap-3 p-3" testId="score-card">
      <svg viewBox="0 0 100 100" className="h-20 w-20 shrink-0 -rotate-90 drop-shadow-[0_0_10px_rgba(34,211,238,0.35)]" role="img" aria-label="MarketScore">
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" className="stroke-white/10" />
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" strokeLinecap="round"
          className="stroke-cyan-400"
          strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - frac)} />
        <text x="50" y="44" textAnchor="middle" dominantBaseline="central" data-bind="marketScore"
          className="origin-center rotate-90 fill-foreground font-mono text-[26px] font-bold">
          {score === null ? DASH : score.toFixed(1)}
        </text>
        <text x="50" y="71" textAnchor="middle" className="origin-center rotate-90 fill-cyan-300 text-[18px] font-semibold">SCORE</text>
      </svg>
      <div className="min-w-0">
        <Accent>MarketScore{rank !== null && <> · #<B k="rank">{rank}</B> of <B k="ranked.length">{of}</B></>}</Accent>
        {score !== null && rival && (
          <Delta k="marketScore − rival.marketScore" value={score - rival.score} digits={1} vs={rival.candidate.name} />
        )}
        <p className="mt-0.5 line-clamp-3 text-sm leading-snug text-zinc-200">
          <B k={brief?.recommended === candidate?.id ? 'brief.why[0]' : 'brief.comparisons[site].betterAt'} mono={false}>{line ?? DASH}</B>
        </p>
      </div>
    </Card>
  );
}

const TONE: Record<StallTone, string> = {
  hot: 'border-vendor/60 bg-vendor/15 text-orange-200',
  even: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200',
  cold: 'border-white/5 bg-black/30 text-zinc-400',
};

export function StallGrid({ result }: { result: SimulationResult }) {
  const stalls = result.stallExposure;
  const mean = stalls.reduce((s, v) => s + v, 0) / stalls.length;
  const busiest = stalls.indexOf(Math.max(...stalls));
  const [picked, setPicked] = useState<number | null>(null);
  const sel = picked !== null && picked < stalls.length ? picked : busiest;
  return (
    <Card className="p-3" testId="stall-grid">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label><B k="result.stallExposure.length">{stalls.length}</B> vendor stalls &amp; fairness</Label>
        <Accent>mean <B k="mean(result.stallExposure)">{mean.toFixed(0)}</B></Accent>
      </div>
      <div className="grid max-h-32 grid-cols-8 gap-1 overflow-y-auto pr-0.5">
        {stalls.map((v, i) => (
          <button key={i} type="button" data-testid="stall" aria-pressed={i === sel} onClick={() => setPicked(i)}
            title={`${v} visitors`}
            className={`rounded-lg border py-0.5 text-center text-sm ${TONE[stallTone(v, mean)]} ${i === sel ? 'ring-1 ring-white' : ''}`}>
            <B k={`result.stallExposure[${i}].slot`}>{i + 1}</B>
          </button>
        ))}
      </div>
      <Tile className="mt-2 flex items-center justify-between px-2.5 py-2" testId="stall-detail">
        <div>
          <div className="text-sm font-bold">Stall #<B k="stall.slot">{sel + 1}</B>{sel === busiest && ' · busiest slot'}</div>
          <div className="text-sm text-zinc-400">
            <B k="stall.exposure/mean">{mean > 0 ? (stalls[sel] / mean).toFixed(2) : DASH}</B>× layout mean · {stallTone(stalls[sel], mean)} flow
          </div>
        </div>
        <div className="text-right font-mono text-lg font-semibold text-cyan-300">
          <B k={`result.stallExposure[${sel}]`}>{stalls[sel]}</B>
          <div className="font-sans text-sm font-normal text-zinc-400">visitors</div>
        </div>
      </Tile>
    </Card>
  );
}

export function PersonaCards({ result, rival }: { result: SimulationResult | null; rival: Ranked | null }) {
  return (
    <Card className="p-3" testId="persona-cards">
      <div className="mb-2 flex items-center justify-between">
        <Label>Persona trade-offs</Label>
        <Accent>{result ? <>seed <B k="result.seed">{result.seed}</B></> : 'Engine'}</Accent>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {PERSONAS.map((p) => {
          const r = result?.personas[p.id];
          const share = r ? servedShare(r.served, r.droppedOut) : null;
          const other = rival?.result.personas[p.id];
          return (
            <Tile key={p.id} className="px-2.5 py-2" testId={`persona-card-${p.id}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm font-bold ${p.text}`}>{p.label}</span>
                <B k={`result.personas.${p.id}.score`} className={`text-2xl font-bold ${p.text}`}>{r?.score}</B>
              </div>
              <div className="mt-1"><Meter share={r ? r.score / 100 : null} className={p.bar} /></div>
              {r && other && rival && (
                <div className="mt-1"><Delta k={`result.personas.${p.id}.score − rival.personas.${p.id}.score`} value={r.score - other.score} vs={rival.candidate.name} /></div>
              )}
              <div className="mt-1 text-sm text-zinc-400">
                served <B k={`result.personas.${p.id}.served`} className="text-zinc-100">{r?.served}</B>
                {' '}· dropped <B k={`result.personas.${p.id}.droppedOut`} className="text-zinc-100">{r?.droppedOut}</B>
                {share !== null && <> · <B k={`served/(served+dropped).${p.id}`}>{pct(share, 0)}</B>%</>}
              </div>
              {r?.verdict && (
                <p className="mt-1 text-sm italic text-zinc-300">
                  <B k={`result.personas.${p.id}.verdict`} mono={false}>{r.verdict}</B>
                </p>
              )}
            </Tile>
          );
        })}
      </div>
    </Card>
  );
}

const WHO: Record<PersonaId, string> = Object.fromEntries(PERSONAS.map((p) => [p.id, p.who])) as Record<PersonaId, string>;

/** One driver row: a label, the bound value, and an optional 0..1 meter. */
function Row({ label, children, share, over }: { label: string; children: ReactNode; share?: number | null; over?: boolean }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-2" data-testid="driver">
      <span className="text-zinc-400">{label}</span>
      <span className="min-w-0">
        <span className={over ? 'text-rose-200' : 'text-zinc-100'}>{children}</span>
        {share !== undefined && <span className="mt-0.5 block"><Meter share={share} className={over ? 'bg-rose-400' : 'bg-cyan-300'} /></span>}
      </span>
    </div>
  );
}

interface DriverContext {
  result: SimulationResult | null; trips: TripStats; candidate: Candidate | undefined;
  streets: StreetStats | null; scenario: Scenario;
}

function BudgetRow({ id, ctx }: { id: PersonaId; ctx: DriverContext }) {
  const b = BUDGETS[id];
  const v = budgetValue(id, ctx.trips, ctx.candidate);
  const share = v === null ? null : v / b.limit;
  const label = b.kind === 'time' ? 'Time budget' : b.kind === 'carry' ? 'Carry distance' : 'Walk budget';
  const k = b.kind === 'carry' ? 'indicators.vanDistM' : b.kind === 'time' ? `meanMinutes(result.trips[${id}])` : `meanMetres(result.trips[${id}])`;
  return (
    <Row label={label} share={share} over={share !== null && share > 1}>
      <B k={k}>{v === null ? DASH : v.toFixed(0)}</B> of <B k={`params.${b.source}`}>{b.limit}</B> {b.unit}
      {share !== null && <> · <B k={`${k}/params.${b.source}`}>{pct(share, 0)}</B>%</>}
    </Row>
  );
}

/** Persona-specific drivers of the binding constraint, each bound to its source. */
function Drivers({ id, ctx }: { id: PersonaId; ctx: DriverContext }) {
  const { result, trips, candidate, streets, scenario } = ctx;
  const rows: ReactNode[] = [<BudgetRow key="budget" id={id} ctx={ctx} />];
  if (trips.trips > 0 && BUDGETS[id].kind !== 'time') {
    rows.push(
      <Row key="trip" label="Mean trip">
        <B k={`meanMetres(result.trips[${id}])`}>{trips.meanM!.toFixed(0)}</B> m · <B k={`meanMinutes(result.trips[${id}])`}>{trips.meanMin!.toFixed(1)}</B> min
      </Row>,
    );
  }
  if (id === 'senior') {
    rows.push(
      <Row key="steps" label="Steps / lifts">
        {streets ? <><B k="streetStats.steps">{streets.steps}</B> steps · <B k="streetStats.elevators">{streets.elevators}</B> lifts</> : <B k="streetStats.steps">{DASH}</B>}
        {result && <> · <B k="count(ELEVATOR_CONGESTION)">{countBottlenecks(result, 'ELEVATOR_CONGESTION')}</B> queues</>}
      </Row>,
    );
  }
  if (id === 'vendor') {
    rows.push(
      <Row key="van" label="Van access">
        {candidate ? (candidate.indicators.deliveryAccess ? '✓ van route' : '✗ no van route') : DASH}
        {streets && <> · <B k="streetStats.bollards">{streets.bollards}</B> bollards</>}
        {result && <> · <B k="count(BOLLARD_BLOCKAGE)">{countBottlenecks(result, 'BOLLARD_BLOCKAGE')}</B> blockages</>}
      </Row>,
    );
  }
  if (id === 'commuter' || id === 'retailer') {
    rows.push(
      <Row key="crowd" label="Crowding">
        <B k="count(CROWDING)">{result ? countBottlenecks(result, 'CROWDING') : DASH}</B> hotspots
      </Row>,
    );
  }
  if (id === 'senior' || id === 'retailer' || id === 'vendor') {
    rows.push(
      <Row key="cobble" label="Cobblestone" share={streets ? streets.mix.cobble : undefined}>
        <B k="streetStats.mix.cobble">{streets ? pct(streets.mix.cobble, 0) : DASH}</B>% of streets
        {result && <> · <B k="count(COBBLESTONE_FRICTION)">{countBottlenecks(result, 'COBBLESTONE_FRICTION')}</B> friction spots</>}
      </Row>,
    );
  }
  rows.push(
    <Row key="rain" label="Rain exposure">
      <B k="1 − streetStats.sheltered">{streets ? pct(1 - streets.sheltered, 0) : DASH}</B>% unsheltered
      {scenario === 'RAINY_SAT' && <span className="text-sky-300"> · raining</span>}
      {/* TODO(subagent): contract needs per-persona minutes walked in the rain (sheltered share of trips) */}
    </Row>,
  );
  return <div className="mt-1.5 flex flex-col gap-1 text-sm">{rows}</div>;
}

export function CitizenChoice({ result, tripSource, ranked, selectedId, candidate, streets, brief, scenario, slice }: {
  /** Ranking result for the selection: persona scores, frictions and bottlenecks. */
  result: SimulationResult | null;
  /** Result whose trips measure the walking numbers: the live run when it matches the selection. */
  tripSource: SimulationResult | null;
  ranked: Ranked[]; selectedId: string | null; candidate: Candidate | undefined;
  streets: StreetStats | null; brief: Brief | null; scenario: Scenario; slice: TimeSlice;
}) {
  const trips = useMemo(() => tripStats(tripSource), [tripSource]);
  const losers = brief?.losers ?? [];
  const cmp = candidate && brief ? brief.comparisons.find((c) => matchesSite(c.site, candidate)) : undefined;
  const worst = result ? [...result.bySlice[slice].bottlenecks].sort((a, b) => b.severity - a.severity)[0] : undefined;
  const ctxBase = { result, candidate, streets, scenario };
  return (
    <Card className="p-3" testId="citizen-choice">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label>Travel constraints &amp; citizen choice</Label>
        <Accent className="shrink-0">Specific drivers</Accent>
      </div>
      <div className="flex flex-col gap-2">
        {PERSONAS.map((p) => {
          const r = result?.personas[p.id];
          const share = r ? servedShare(r.served, r.droppedOut) : null;
          const bind = bindingBottleneck(result, p.id);
          const choice = citizenChoice(ranked, p.id, selectedId);
          const fix = losers.find((l) => l.persona === p.id);
          return (
            <Tile key={p.id} className="relative overflow-hidden py-2 pl-3.5 pr-2.5" testId={`citizen-card-${p.id}`}>
              <span className={`absolute inset-y-0 left-0 w-1 ${p.bar}`} aria-hidden="true" />
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-sm font-bold ${p.text}`}>{p.label} · {WHO[p.id]}</span>
                {choice && (choice.here ? (
                  <span className="shrink-0 text-sm text-emerald-300" data-testid="citizen-choice-here">✓ prefers this site</span>
                ) : (
                  <span className="shrink-0 truncate text-sm text-amber-200" data-testid="citizen-choice-away">
                    → <B k={`argmax(ranked.personas.${p.id}.score).name`} mono={false}>{choice.best.candidate.name}</B>
                  </span>
                ))}
              </div>
              <div className="mt-1 text-sm">
                <span className="text-zinc-400">Binding: </span>
                <B k={`result.personas.${p.id}.topFriction`} mono={false} className="font-semibold text-zinc-50">{r?.topFriction}</B>
                {bind.worst && (
                  <div className="text-zinc-400">
                    worst <B k={`bottleneck[${p.id}].cause`} mono={false}>{bind.worst.cause}</B> at <B k={`bottleneck[${p.id}].time`}>{bind.worst.time}</B>,
                    severity <B k={`bottleneck[${p.id}].severity`}>{bind.worst.severity.toFixed(2)}</B>
                    {' '}(<B k={`count(bottlenecks[${p.id}])`}>{bind.count}</B> in the day)
                  </div>
                )}
              </div>
              <Drivers id={p.id} ctx={{ ...ctxBase, trips: trips[p.id] }} />
              <div className="mt-1.5 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 text-sm">
                <span className="text-zinc-400">Served</span>
                <span>
                  <B k={`result.personas.${p.id}.served`}>{r?.served}</B> · dropped <B k={`result.personas.${p.id}.droppedOut`}>{r?.droppedOut}</B>
                  {share !== null && <> · <B k={`served/(served+dropped).${p.id}`} className={share < 0.85 ? 'text-rose-200' : 'text-emerald-200'}>{pct(share, 0)}</B>%</>}
                </span>
                <span className="text-zinc-400">Choice</span>
                <span data-testid="citizen-choice-score">
                  {choice ? (
                    <>
                      <B k={`argmax(ranked.personas.${p.id}.score).name`} mono={false}>{choice.best.candidate.name}</B>
                      {' '}<B k={`argmax(ranked.personas.${p.id}.score).score`}>{choice.bestScore}</B>
                      {!choice.here && choice.hereScore !== null && (
                        <> · here <B k={`result.personas.${p.id}.score`}>{choice.hereScore}</B></>
                      )}
                    </>
                  ) : <B k={`argmax(ranked.personas.${p.id}.score)`}>{DASH}</B>}
                </span>
              </div>
              {r?.verdict && (
                <p className="mt-1.5 text-sm italic text-zinc-300">
                  <span className="not-italic text-cyan-300">Claude: </span><B k={`result.personas.${p.id}.verdict`} mono={false}>{r.verdict}</B>
                </p>
              )}
              {fix && (
                <p className="mt-1 text-sm text-zinc-300">
                  <span className="text-cyan-300">Claude mitigation: </span><B k="brief.losers[persona].mitigation" mono={false}>{fix.mitigation}</B>
                </p>
              )}
              {p.id === 'retailer' && (
                // TODO(subagent): contract needs PersonaId values for resident / tourist / passer trips
                <p className="mt-1 text-sm text-zinc-500" data-testid="citizen-retailer-note">
                  Residents, tourists and passers share this agent type in the engine output.
                </p>
              )}
            </Tile>
          );
        })}
        {worst && (
          <Tile className="relative overflow-hidden py-2 pl-3.5 pr-2.5 text-sm" testId="constraint-bottleneck">
            <span className="absolute inset-y-0 left-0 w-1 bg-rose-400" aria-hidden="true" />
            <span className="font-bold text-rose-300">Worst bottleneck at <B k="slice">{sliceParts(slice).clock}</B>:</span>{' '}
            <B k={`bySlice.${slice}.bottlenecks[maxSeverity].cause`} mono={false}>{worst.cause}</B>
            {' '}at <B k={`bySlice.${slice}.bottlenecks[maxSeverity].time`}>{worst.time}</B>, severity <B k={`bySlice.${slice}.bottlenecks[maxSeverity].severity`}>{worst.severity.toFixed(2)}</B>
          </Tile>
        )}
        {cmp && (
          <Tile className="relative overflow-hidden py-2 pl-3.5 pr-2.5 text-sm" testId="constraint-brief">
            <span className="absolute inset-y-0 left-0 w-1 bg-cyan-400" aria-hidden="true" />
            <span className="font-bold text-cyan-300">Brief:</span> better at <B k="brief.comparisons[site].betterAt" mono={false}>{cmp.betterAt}</B>;
            worse at <B k="brief.comparisons[site].worseAt" mono={false}>{cmp.worseAt}</B>
          </Tile>
        )}
        {brief && brief.recommended === candidate?.id && brief.why.map((w, i) => (
          <Tile key={i} className="relative overflow-hidden py-2 pl-3.5 pr-2.5 text-sm" testId="constraint-brief">
            <span className="absolute inset-y-0 left-0 w-1 bg-cyan-400" aria-hidden="true" />
            <span className="font-bold text-cyan-300">Why recommended:</span> <B k={`brief.why[${i}]`} mono={false}>{w}</B>
          </Tile>
        ))}
        {streets && (
          <p className="text-sm text-zinc-500">
            Street figures cover footways within <B k="STREET_RADIUS_M">{STREET_RADIUS_M}</B> m; trips from <B k="tripSource.trips.length">{tripSource?.trips.length}</B> engine agents.
          </p>
        )}
      </div>
    </Card>
  );
}

