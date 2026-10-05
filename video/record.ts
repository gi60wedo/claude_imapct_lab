// Records the seeded demo run as a 1080p MP4 (pitch opener + offline fallback).
//
//   npm run video                                  # app on http://localhost:5173, seed 42
//   npm run video -- --url http://localhost:4173 --seed 7 --out video/take2.mp4
//   npm run video -- --smoke                       # no app needed: checks Playwright + ffmpeg end to end
//
// The UI (part C) exposes these hooks; a missing hook is skipped with a warning, so takes work while the UI grows:
//   data-testid="map-ready"            present once the map and data have loaded
//   data-testid="show-candidates"      reveal all discovered candidates
//   data-testid="apply-filter"         grey out rejected sites
//   data-testid="run-simulation"       run the shortlist; data-testid="sim-done" appears when finished
//   data-testid="candidate-<id>"       focus one site (e.g. candidate-lorenzkirche)
//   data-testid="apply-mitigation"     Claude mitigation loop
//   data-testid="scenario-RAINY_SAT"   what-if bar;  data-testid="preset-trader-fairness" weight preset
// Captions are computed from public/data/candidates.json — no number in the video is typed by hand.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import type { CandidatesFile } from '../src/contracts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:5173' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: 'video/urbantwin.mp4' },
    smoke: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
});

const W = 1920, H = 1080;
const data: CandidatesFile = JSON.parse(readFileSync(resolve(root, 'public/data/candidates.json'), 'utf8'));
const cands = data.candidates;
const byId = new Map(cands.map(c => [c.id, c]));
const rejected = cands.filter(c => !c.passedFilter);
const shortlist = data.meta.rank?.shortlist ?? [];
const m = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} m`);

function vanLine(id: string): string {
  const c = byId.get(id);
  if (!c) return '';
  const ev = c.evidence!;
  return c.indicators.vanDistM >= 0
    ? `${c.name}: legal 05:30 van stop ${m(c.indicators.vanDistM)} from the site` +
      (ev.vanToCentreM != null ? `, ${m(ev.vanToCentreM)} to its centre` : '')
    : `${c.name}: no legal 05:30 van access (${ev.blockedBy?.restriction ?? 'no road'})`;
}

interface Shot { caption: string; action?: (p: Page) => Promise<void>; holdMs: number }

const click = (id: string) => async (p: Page) => {
  const el = p.getByTestId(id);
  if (await el.count()) await el.first().click();
  else console.warn(`  ! hook data-testid="${id}" not found — skipped`);
};
const waitFor = (id: string, timeout: number) => async (p: Page) => {
  await p.getByTestId(id).first().waitFor({ timeout }).catch(() => console.warn(`  ! data-testid="${id}" did not appear within ${timeout} ms`));
};
const all = (...fs: ((p: Page) => Promise<void>)[]) => async (p: Page) => { for (const f of fs) await f(p); };

const shots: Shot[] = [
  { caption: 'The market has to move. Where?', action: waitFor('map-ready', 20000), holdMs: 5000 },
  { caption: `${cands.length} candidate sites found in the Altstadt (OSM squares, pedestrian areas, vacant ground floors)`,
    action: click('show-candidates'), holdMs: 6000 },
  { caption: `${rejected.length} rejected with a stated reason: too small, no transit, or no legal van stop`,
    action: click('apply-filter'), holdMs: 6000 },
  { caption: `Simulating the shortlist: ${shortlist.map(id => byId.get(id)?.name ?? id).join(' · ')}`,
    action: all(click('run-simulation'), waitFor('sim-done', 20000)), holdMs: 7000 },
  { caption: vanLine('lorenzkirche'), action: click('candidate-lorenzkirche'), holdMs: 6000 },
  { caption: vanLine('kaufhof'), action: click('candidate-kaufhof'), holdMs: 6000 },
  { caption: 'Claude proposes a mitigation — the engine re-simulates it', action: click('apply-mitigation'), holdMs: 6000 },
  { caption: 'What if it rains, and the city puts trader fairness first?',
    action: all(click('scenario-RAINY_SAT'), click('preset-trader-fairness')), holdMs: 6000 },
];

const credits = [
  'UrbanTwin: Market-Sim · Claude Impact Lab #2',
  `Seeded run · seed ${args.seed} · reference day ${data.meta.referenceDay}`,
  'Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0',
  '© OpenStreetMap contributors (ODbL)',
  'Statistisches Bundesamt (Destatis), Zensus 2022, dl-de/by-2-0 · VGN open data',
];

async function overlay(p: Page, caption: string | null, lines?: string[]) {
  await p.evaluate(([caption, lines]) => {
    let el = document.getElementById('__ut_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__ut_caption';
      el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 34px/1.35 system-ui,sans-serif;' +
        'color:#fff;text-shadow:0 2px 8px #000;transition:opacity .4s';
      document.body.appendChild(el);
    }
    if (lines) {
      el.style.cssText += ';inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;' +
        'gap:14px;background:#0b1220;font-size:30px;font-weight:500;text-align:center';
      el.innerHTML = lines.map((l, i) => `<div style="${i ? '' : 'font-size:44px;font-weight:700'}">${l}</div>`).join('');
    } else {
      el.style.cssText += ';left:0;right:0;bottom:64px;text-align:center;padding:0 120px';
      el.textContent = caption;
    }
  }, [caption, lines ?? null] as const);
}

async function main() {
  const outPath = resolve(root, args.out!);
  const tmp = resolve(root, 'video/.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const browser = await chromium.launch({ headless: !args.headed });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1,
                                         recordVideo: { dir: tmp, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const url = args.smoke ? 'about:blank' : `${args.url}/?seed=${args.seed}&demo=1`;
  console.log(`recording ${url}`);
  await page.goto(url);
  if (args.smoke) await page.setContent('<body style="margin:0;background:#1d2b3a"></body>');
  for (const s of shots) {
    console.log(`  ▸ ${s.caption}`);
    await overlay(page, s.caption);
    if (s.action && !args.smoke) await s.action(page);
    await page.waitForTimeout(args.smoke ? 600 : s.holdMs);
  }
  await overlay(page, null, credits);
  await page.waitForTimeout(args.smoke ? 800 : 5000);
  const video = page.video()!;
  await ctx.close();
  await browser.close();
  const webm = await video.path();
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            '-crf', '18', '-r', '30', '-movflags', '+faststart', outPath], { stdio: 'inherit' });
  } catch {
    const fallback = outPath.replace(/\.mp4$/, '.webm');
    renameSync(webm, fallback);
    console.warn(`ffmpeg not available — kept the raw recording: ${fallback}`);
    return;
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
