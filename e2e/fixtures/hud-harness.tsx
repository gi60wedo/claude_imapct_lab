import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { PersonaId } from '../../src/contracts';
import type { SimClient } from '../../src/ui/adapters/types';
import { fixtureSim } from '../../src/ui/adapters/fixtures';
import SceneHUD from '../../src/ui/scenes/SceneHUD';
import type { SceneState } from '../../src/ui/scenes/types';
import '../../src/index.css';

// Vite serves this entry only for the component test; it is not an app entry.
if (!import.meta.env.DEV) throw new Error('HUD harness requires the Vite dev server');

const sim: SimClient = fixtureSim;
const before = await sim.run('KAUFHOF', 'SUNNY_SAT', [], 42);
const after = await sim.run('KAUFHOF', 'RAINY_SAT', [], before.seed);
const root = createRoot(document.getElementById('root')!);
const render = (applied: boolean) => {
  const result = applied ? after : before;
  const captions: Array<SceneState['captions'][number]> = (['senior', 'vendor', 'commuter', 'retailer'] as PersonaId[]).flatMap<SceneState['captions'][number]>((persona) => [
    { id: `${persona}-score`, slot: 'personaChip', persona, opacity: applied ? 1 : 0.5,
      parts: [{ kind: 'binding', path: `personas.${persona}.score`, format: 'int',
        text: String(Math.round(result.personas[persona].score)) }] },
    { id: `${persona}-friction`, slot: 'frictionChip', persona, opacity: 1,
      parts: [{ kind: 'binding', path: `personas.${persona}.topFriction`, format: 'text', text: result.personas[persona].topFriction }] },
    { id: `${persona}-served`, slot: 'personaChip', persona, opacity: 1,
      parts: [{ kind: 'text', text: 'Served ' }, { kind: 'binding', path: `personas.${persona}.served`,
        text: String(Math.round(result.personas[persona].served)) }] },
  ]);
  captions.push({ id: 'decimal', slot: 'footer', opacity: 1, parts: [
    { kind: 'binding', path: 'criteria.accessibility', format: 'num1', text: result.criteria.accessibility.toFixed(1) },
  ] });
  if (applied) captions.push({ id: 'comparison', slot: 'footer', opacity: 1, parts: [
    { kind: 'binding', path: 'before.personas.commuter.score', format: 'int', text: String(Math.round(before.personas.commuter.score)) },
    { kind: 'text', text: ' → ' },
    { kind: 'binding', path: 'after.personas.commuter.score', format: 'int', text: String(Math.round(after.personas.commuter.score)) },
  ] });
  // The HUD consumes only this presentation subset of SceneState.
  const state = { phase: applied ? 'paused' : 'awaiting-action', result, captions,
    scope: { result, before, after: applied ? after : null,
      scene: { simSec: result.trips[0]?.path[0]?.[2] ?? 0, seed: result.seed,
        scenario: result.scenario, candidateId: result.candidateId, dataSource: 'fixtures' } },
  } as unknown as SceneState;
  Object.assign(window, { hudFixtureState: state });
  root.render(createElement(SceneHUD, { state, onApply: () => render(true) }));
};
render(false);
