/**
 * RZ-static: rule zero checked on the scene source, without a browser.
 *
 * - Caption templates in `scene1.ts`, `scene2.ts` (any `scene<N>.ts`) contain
 *   no digit outside `{…}` bindings. Clock labels bind `{scene.simSec|clock}`.
 * - Every binding parses against the grammar in `types.ts`.
 * - No scene source file holds a quoted percentage such as `"42 %"`
 *   (`grep -nE '"[^"{]*[0-9]+ ?%' src/ui/scenes`, widened to all quote kinds).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePath, parseTemplate, TemplateParseError } from './bind';
import { validateSceneDef } from './director';
import type { SceneDef } from './types';

const SCENES_DIR = resolve(process.cwd(), 'src/ui/scenes');
const DIGIT = /\p{Nd}/u;
const QUOTED_PERCENT = /["'`][^"'`{]*[0-9]+ ?%/;

/** Every rule-zero violation in a scene definition's caption templates. */
function rzStaticViolations(def: SceneDef): string[] {
  const out: string[] = [];
  for (const kf of def.keyframes) {
    for (const c of kf.captions) {
      const where = `scene ${def.id} ${kf.id} caption ${c.id}`;
      let parts;
      try {
        parts = parseTemplate(c.template);
      } catch (e) {
        if (!(e instanceof TemplateParseError)) throw e;
        out.push(`${where}: ${e.message}`);
        continue;
      }
      for (const p of parts) {
        if (p.kind === 'text' && DIGIT.test(p.text)) out.push(`${where}: digit in literal text ${JSON.stringify(p.text)}`);
        if (p.kind === 'binding' && !parsePath(p.path)) out.push(`${where}: binding path does not parse: ${p.path}`);
      }
    }
  }
  return out;
}

const isSceneDef = (v: unknown): v is SceneDef =>
  typeof v === 'object' && v !== null && Array.isArray((v as SceneDef).keyframes) && typeof (v as SceneDef).id === 'string';

const sceneModules = import.meta.glob<Record<string, unknown>>('./scene[0-9]*.ts', { eager: true });
const sceneDefs = Object.entries(sceneModules).flatMap(([file, mod]) =>
  Object.entries(mod).filter(([, v]) => isSceneDef(v)).map(([name, v]) => ({ file, name, def: v as SceneDef })),
);

const sourceFiles = readdirSync(SCENES_DIR).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

describe('RZ-static checker', () => {
  const def = (template: string): SceneDef => ({
    id: '1', title: 't', candidateId: 'c', scenario: 'SUNNY_SAT', seed: 1, heroes: [],
    keyframes: [{
      id: 'K0', t: 0, durationMs: 1, camera: { kind: 'fixed', viewState: { longitude: 0, latitude: 0, zoom: 0, pitch: 0, bearing: 0 } },
      transition: 'cut', transitionMs: 0, sim: { mode: 'paused' }, layers: [],
      captions: [{ id: 'c', slot: 'title', template }],
    }],
  });

  it('accepts digits inside bindings only', () => {
    expect(rzStaticViolations(def("Markus: {personas.vendor.score} · {bySlice['05:30_DELIVERY'].bottlenecks[0].time}"))).toEqual([]);
    expect(rzStaticViolations(def('St. Lorenzkirche · {scene.simSec|clock}'))).toEqual([]);
  });

  it('flags literal numbers, clock text and broken bindings', () => {
    expect(rzStaticViolations(def('Markus: 22'))).toHaveLength(1);
    expect(rzStaticViolations(def('St. Lorenzkirche · 05:30'))).toHaveLength(1);
    expect(rzStaticViolations(def('Served ٣ {personas.senior.served}'))).toHaveLength(1);
    expect(rzStaticViolations(def('{personas..score}'))).toHaveLength(1);
    expect(rzStaticViolations(def('oops {x'))).toHaveLength(1);
  });

  it('flags quoted percentages', () => {
    expect(QUOTED_PERCENT.test('caption: "Served 42 %"')).toBe(true);
    expect(QUOTED_PERCENT.test("caption: 'up 7%'")).toBe(true);
    expect(QUOTED_PERCENT.test('template: "{personas.vendor.score} %"')).toBe(false);
  });
});

describe('RZ-static on scene files', () => {
  it('scans the scene source directory', () => {
    expect(sourceFiles).toContain('director.ts');
  });

  it('holds no quoted percentage in any scene source file', () => {
    const hits = sourceFiles.flatMap((f) =>
      readFileSync(join(SCENES_DIR, f), 'utf8')
        .split('\n')
        .map((line, i) => ({ f, line: i + 1, text: line }))
        .filter((l) => QUOTED_PERCENT.test(l.text)),
    );
    expect(hits).toEqual([]);
  });

  if (sceneDefs.length === 0) {
    it.skip('scene1.ts and scene2.ts are not written yet (S5, S6)', () => {});
  }

  for (const { file, name, def } of sceneDefs) {
    it(`${file} ${name}: caption templates have no digit outside bindings`, () => {
      expect(rzStaticViolations(def)).toEqual([]);
    });

    it(`${file} ${name}: scene definition is valid`, () => {
      expect(validateSceneDef(def)).toEqual([]);
    });
  }
});
