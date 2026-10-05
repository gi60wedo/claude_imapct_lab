import type { ReactNode } from 'react';
import type { PersonaId } from '../../contracts';
import type { SceneState } from './types';
import { formatClock } from './bind';
import PersonaChip, { CaptionText } from './PersonaChip';

export interface SceneHUDProps {
  /** The director supplies scene state; the HUD never reads window.__scene. */
  state: SceneState;
  onApply?: () => void | Promise<unknown>;
  /** SceneView can supply its own gate action control. */
  applySlot?: ReactNode;
}

const personas: readonly PersonaId[] = ['senior', 'vendor', 'commuter', 'retailer'];

function errorMessage(error?: string) {
  if (error?.startsWith('mitigation rerun failed:')) return 'Mitigation unavailable. Please try again.';
  if (error?.startsWith('scene data failed to load:')) return 'Scene data unavailable. Please try again.';
  return 'Scene unavailable. Please try again.';
}

/** Pure presentation of director-resolved values, including before/after bindings. */
export function SceneHUD({ state, onApply, applySlot }: SceneHUDProps) {
  const { captions, scope, phase } = state;
  const pending = phase === 'awaiting-action';
  const rerunning = phase === 'rerunning';
  const ungrouped = captions.filter((c) => c.slot !== 'personaChip' && c.slot !== 'frictionChip'
    || !c.persona);
  const renderSlot = (slot: string) => ungrouped.filter((c) => c.slot === slot).map((caption) => (
    <p key={caption.id} data-caption-id={caption.id}
      style={{ opacity: caption.opacity }}
      className={`break-words ${slot === 'title'
        ? 'text-4xl font-semibold' : 'text-xl tabular-nums'}`}>
      <CaptionText caption={caption} />
    </p>
  ));

  return (
    <div data-testid="scene-hud" aria-label="Scene information"
      className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-6 p-6 text-lg text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl space-y-3 rounded-xl bg-background/90 p-5 shadow-lg empty:hidden">
          {renderSlot('title')}{renderSlot('subtitle')}
        </div>
        {scope && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/95 p-4 text-lg tabular-nums">
          <span aria-label="Simulation clock" data-bind="scene.simSec" data-format="clock">{formatClock(scope.scene.simSec)}</span>
          <span>Seed <span data-bind="scene.seed" data-format="text">{String(scope.scene.seed)}</span></span>
          <span data-bind="scene.scenario" data-format="text">{scope.scene.scenario}</span>
          <span>engine output</span>
          {scope.scene.dataSource === 'fixtures' && <span data-testid="scene-fixture"
            className="rounded-lg border border-border bg-surface px-3 py-1"
            data-bind="scene.dataSource" data-format="text">{scope.scene.dataSource}</span>}
        </div>}
      </header>

      <div className="space-y-4">
        <div className="space-y-2 rounded-xl bg-background/90 p-4 empty:hidden">
          {renderSlot('clock')}{renderSlot('personaChip')}{renderSlot('frictionChip')}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {personas.map((persona) => <PersonaChip key={persona} persona={persona}
            captions={captions.filter((c) => c.persona === persona
              && (c.slot === 'personaChip' || c.slot === 'frictionChip'))} />)}
        </div>
        <footer className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-4xl space-y-2 rounded-xl bg-background/90 p-4 empty:hidden">{renderSlot('footer')}</div>
          {(pending || rerunning) && <div className="pointer-events-auto rounded-xl bg-background/95 p-4">
            {applySlot ?? <button type="button" onClick={() => { void onApply?.(); }}
              disabled={rerunning || !onApply} aria-busy={rerunning}
              className="min-h-12 rounded-lg border border-commuter bg-commuter/20 px-5 py-3 text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-commuter disabled:cursor-wait disabled:opacity-60">
              {rerunning ? 'Engine re-simulating' : 'Apply Claude mitigation'}
            </button>}
          </div>}
        </footer>
        {phase === 'loading' && <p role="status" className="rounded-xl bg-background/95 p-4">Loading engine output…</p>}
        {phase === 'error' && <p role="alert" className="rounded-xl border border-vendor bg-background/95 p-4">{errorMessage(state.error)}</p>}
      </div>
    </div>
  );
}

export default SceneHUD;
