# Role C · Map, Ranking & Cockpit UI: Agent Orchestration Plan

UrbanTwin: Market-Sim · Claude Impact Lab #2 · Build window 13:00–20:00
Owner: Mahesh (orchestrator) · Owns `src/ui/` and the pre-event scaffold
Source of truth for scope, contract and gates: `IMPLEMENTATION_PLAN.md` (§1 tiers, §5 contract, §7 role C, §10 gates)

**Done-check for role C (from §7):** a weight change reorders the ranking in under 100 ms, and the map holds 60 fps with 100 trails.

---

## 0. Ground truth checked on this machine (2026-10-05)

| Item | Finding | Consequence for the plan |
|---|---|---|
| Repo | `claude_imapct_lab` is its own Git repo on `main` (`dcac2bb`), remote `gi60wedo/claude_imapct_lab`. It has no `package.json`, no `src/`, no `public/`. | The whole scaffold (C0) is still to do. |
| `.scratch/` | Not listed in `.git/info/exclude`. | Add it before the first `ruddr run` so briefs and run state stay out of diffs. |
| `datasets/dop20/` | 4 JPEG quadrants, each 4200 × 4200 px, 1050 m × 1050 m (0.25 m/px). The filename holds the bbox `minx_miny_maxx_maxy` in EPSG:25832. Total 12 MB. | Downscale to 2100 px (0.5 m/px) for GPU memory. Convert the 4 corners of each quadrant to WGS84 and use the 4-corner `bounds` form of `BitmapLayer`. A UTM rectangle is slightly rotated in lng/lat (≈1.5° convergence at 11.08° E, zone 32 meridian is 9° E), so a 2-corner bbox would misalign by several metres at the edges. |
| `datasets/alkis/` | 4 transparent PNG overlays with the same bbox naming. | Optional overlay with the same corner transform. |
| `datasets/lod2/` | 4 CityGML tiles, 525 MB total, `bldg:measuredHeight` present, ~6,760 buildings in one tile, CRS ETRS89/UTM32. | The browser cannot load this. Somebody must convert it to a small `buildings.json` (footprint + height). |
| `datasets/osm/altstadt.json` | Overpass JSON (`elements[]` with inline `geometry`): 3,908 building ways (2,013 with `building:levels`, 182 with `height`), 224 bollards, 4,148 highway features. | Fallback for 3D buildings: OSM footprints, height = `height` or `building:levels × 3 m` or 9 m. Bollard markers come straight from OSM nodes. |
| Node / tools | `node v26.4.0`, `npx`, `bun`; no `pnpm`. Playwright browsers cached in `~/.cache/ms-playwright` (`chromium-1243`), but the `playwright` package is not installed in this repo. | Use `npm`. Add `@playwright/test` as a dev dependency in C0. |
| `codex` | `codex-cli 0.160.0`. `~/.codex/config.toml`: `model = "gpt-6.1-sol"`, `model_reasoning_effort = "medium"`, `sandbox_mode = "danger-full-access"`, `approval_policy = "never"`. | Codex defaults to full access with no approvals. Always pass a sandbox explicitly. |
| `claude` | `2.1.289 (Claude Code)`. | Headless mode works with `-p`, `--model`, `--effort`, `--permission-mode`, `--max-budget-usd`, `-w/--worktree`. |
| `ruddr` | `ruddr 0.6.3`, skill at `~/.claude/skills/ruddr-delegate/SKILL.md`. Model catalog (`ruddr models --json`): Codex `gpt-6.1-sol` (efforts low…ultra), `gpt-6-luna`, others; Claude `claude-opus-5-5` (default), `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-sonnet-5`. **`claude-sonnet-5-5` is not in the Ruddr catalog**, and the catalog lists no efforts for Claude models. | Run `ruddr models add claude claude-sonnet-5-5 --label "Claude Sonnet 5.5"` once before the event, then confirm with `ruddr models --json`. If a Claude `--effort` is rejected by Ruddr, drop the flag or launch that agent with `claude -p` instead. |

---

## 1. Design choices that keep the task tree small

1. **One store, three adapters, one layout file. Mahesh writes these by hand.** They are about 120 lines total and they are the only files that every subtask touches. Agents may import them and may not edit them.
   - `src/ui/state/store.ts`: a tiny `useSyncExternalStore` store (no new dependency). It holds `candidates`, `results: Record<candidateId, SimulationResult>`, `weights`, `scenario`, `slice`, `selectedId`, `brief`, `playing`, `timeSec`.
   - `src/ui/adapters/types.ts`: `SimClient { run(candidateId, scenario, mitigations, seed): Promise<SimulationResult> }` and `BriefClient { brief(input): Promise<Brief> }`.
   - `src/ui/adapters/fixtures.ts`: both clients backed by `public/data/mock-*.json`.
   - `src/ui/App.tsx`: a CSS grid with four named slots (`map`, `ranking`, `whatif`, `cockpit`).
2. **The UI never computes a criterion.** It reads `SimulationResult.criteria` and computes only the weighted sum with the active weights. Until D's `src/score/` exports a function, C uses a 10-line `weightedScore()` in `src/ui/ranking/applyWeights.ts` and swaps the import at 17:00.
3. **Base map without vector tiles.** The DOP20 bitmap is the base. MapLibre runs with an empty style (`{version: 8, sources: {}, layers: [{id:'bg', type:'background', paint:{'background-color':'#111'}}]}`) and deck.gl draws on top through `@deck.gl/mapbox` `MapboxOverlay` in interleaved mode. The demo then works offline.
4. **Static C assets live in `public/base/`, owned by C.** A owns `public/data/`. C never writes there except for the fixtures committed jointly at 13:20.
5. **One deck.gl version.** All `@deck.gl/*` packages are pinned to the same exact version in `package.json`, with no caret.

---

## 2. Task tree

Tier tags follow §1 of the master plan: **M** = Must, **S** = Should, **X** = Stretch (skipped unless all M and S items are merged by 16:30).

### 2.1 Pre-event (before 13:00)

| ID | Tier | Subtask | Files | Depends on | Done-condition (orchestrator runs it) |
|---|---|---|---|---|---|
| **C0** | M | Repo scaffold: Vite + React + TS, Tailwind, deck.gl + MapLibre, Vitest, Playwright, ESLint off. `src/contracts.ts` with the §5 types pasted as a *draft* (freeze at 13:20). Empty folders `src/rank/ src/sim/ src/score/ server/` with `.gitkeep`. `npm run dev`, `build`, `test`, `e2e` scripts. | `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/main.tsx`, `src/index.css`, `src/contracts.ts`, `playwright.config.ts`, `.gitignore` | none | `npm ci && npm run build && npm test -- --run && npx tsc --noEmit -p tsconfig.app.json` all exit 0; `npm ls @deck.gl/core` prints exactly one version; `git grep -nE 'sk-ant|ANTHROPIC_API_KEY=' -- . ':!*.md'` prints nothing. |
| **C1** | M | Base assets: script converts the 4 DOP20 quadrants to 2100 px JPEGs plus `public/base/dop20.json` (`[{url, bounds:[[lng,lat]×4]}]`, corners in order bottom-left, top-left, top-right, bottom-right). Same for ALKIS PNGs. Fallback `public/base/buildings-osm.json` from OSM building ways. | `tools/base_assets.py`, `public/base/*` | C0 | `uv run --with pyproj --with pillow python tools/base_assets.py` exits 0; `public/base/` < 15 MB; a Python check confirms Lorenzkirche `11.07773, 49.45095` falls inside exactly one quadrant's corner polygon; building count ≥ 3,000. |
| **C2** | M | UI fixtures that match §5 exactly: 18 candidates (3 benchmarks, ≥ 5 rejected with `rejectReason`), 3 `SimulationResult`s × `SUNNY_SAT`/`RAINY_SAT`, ≥ 100 trips along real OSM footways, 1 `Brief`. A Vitest file type-checks every fixture against `contracts.ts`. | `src/ui/__fixtures__/gen.ts`, `src/ui/__fixtures__/*.json`, `src/ui/__fixtures__/fixtures.test.ts` | C0, C1 | `npm test -- --run src/ui/__fixtures__` passes; `npx tsc --noEmit` passes with `resolveJsonModule`; trip count ≥ 100 per result. These become `public/data/mock-*.json` at 13:20 if B and D have nothing better. |
| **C3a** | M | Orchestrator files from §1.1 (store, adapters, App layout). | `src/ui/state/store.ts`, `src/ui/adapters/*`, `src/ui/App.tsx` | C0 | Mahesh writes them. `npm run build` passes. |

**Pre-event agent ask to A:** `public/data/buildings.json` = `[{polygon:[[lng,lat]…], h:number}]` from LoD2 `measuredHeight`. If it is not committed by 13:00, C uses `public/base/buildings-osm.json` and swaps later by changing one URL.

### 2.2 13:00–15:00 (gate 15:00: "UI shows fixtures end to end")

| ID | Tier | Subtask | Files | Depends on | Done-condition |
|---|---|---|---|---|---|
| **C4** | M | Map shell and static layers: MapLibre + `MapboxOverlay`, DOP20 `BitmapLayer`s, extruded buildings (`SolidPolygonLayer` or `PolygonLayer` with `extruded`), candidate polygons colored by rank, rejected ones grey with a tooltip that shows `rejectReason`, click selects a candidate. Bollards from OSM as `ScatterplotLayer`. Attribution line from §3. | `src/ui/map/**` | C0–C3a | `npm run e2e -- map.spec.ts` passes: canvas visible, no console errors, tooltip with the reject reason appears on hover of a rejected candidate; screenshot `e2e/__shots__/map.png` saved and inspected by Mahesh (aerial photo aligns with building extrusions at Lorenzkirche). |
| **C5** | M + S | Ranking panel: MarketScore bars sorted by weighted score, 5 weight sliders with live renormalization (sum = 1), 3 presets from §6, guard badge "fails a stakeholder group" when any persona < 40, rejected list collapsed below. | `src/ui/ranking/**` | C3a | Vitest: `applyWeights` renormalizes and reorders on preset change, guard flag fires below 40. Playwright `ranking.spec.ts`: sets the accessibility slider, measures `performance.now()` from `input` to the DOM order change via `MutationObserver`, median of 20 changes < 100 ms. |
| **C6** | M | Cockpit: consensus dial (min and mean of persona scores), 4 persona cards (score, `topFriction` chip, `verdict`), brief panel rendering `why`, `comparisons`, `losers`, buttons **Apply Claude mitigation** (calls `SimClient.run` with `losers[*].mitigation`) and **Export council brief** (downloads `councilBriefMd` as `.md`). | `src/ui/cockpit/**` | C3a | Playwright `cockpit.spec.ts`: 4 cards render the fixture scores verbatim; clicking Export yields a download whose text equals `brief.councilBriefMd`; clicking Apply calls the adapter once (spy) and re-renders the cards. |

### 2.3 15:00–16:30 (dynamics)

| ID | Tier | Subtask | Files | Depends on | Done-condition |
|---|---|---|---|---|---|
| **C7** | M + S | Simulation layers: `TripsLayer` with persona colours (senior purple, vendor orange, commuter blue, retailer grey), `HeatmapLayer` from `bySlice[slice].heat`, bottleneck markers sized by `severity`, kiosk markers when `mitigations` is non-empty. Time-slice slider (05:30 / 11:30 / 15:00) and play/pause driving `timeSec` through one `requestAnimationFrame` loop. In-app FPS probe on `window.__fps` when the URL has `?perf=1`. | `src/ui/map/simLayers.ts`, `src/ui/controls/**`, `src/ui/perf/fps.ts` | C4 | `perf.spec.ts` run **headed** on the demo laptop: `?perf=1` with 100 trails playing, median of `window.__fps` over 10 s ≥ 55, 3 runs out of 3. Screenshot `e2e/__shots__/trails.png` shows trails and heatmap. |
| **C8** | M + S | What-if bar: Sunny / Rainy / Christmas market buttons that call `SimClient.run` for the shortlist and show a spinner; side-by-side compare of two selected candidates (S). | `src/ui/whatif/**`, `src/ui/compare/**` | C3a, C5 | Playwright `whatif.spec.ts`: clicking Rainy loads `RAINY_SAT` fixtures and changes at least one bar value; compare view shows both candidates' 5 criteria. |
| **C9** | X | Draw a custom site (`EditableGeoJsonLayer` is out; use 4 clicks → polygon). | `src/ui/draw/**` | all M | Only started if C4–C8 are merged by 16:30. |

### 2.4 17:00–18:00 (integration, freeze 18:00)

| ID | Tier | Subtask | Files | Depends on | Done-condition |
|---|---|---|---|---|---|
| **C10** | M | Swap adapters: `adapters/worker.ts` wraps B's Web Worker; `adapters/http.ts` POSTs to `/api/brief`; import D's MarketScore in place of `applyWeights`. Feature flag `?data=fixtures` keeps the fixture path alive. | `src/ui/adapters/**`, one import line in `src/ui/ranking/applyWeights.ts` | C4–C8, B worker, D route | Full demo path (§11 pitch order) runs 3 times in a row in `demo.spec.ts` with real adapters; `?data=fixtures` still passes all specs. |
| **C11** | M | Projector polish: contrast, font size ≥ 16 px, persona colours readable on the aerial photo. | `src/index.css`, `src/ui/**` styles | C10 | Mahesh checks on the projector at 18:00. |

---

## 3. Agent assignment

Provider facts used below come from `ruddr models --json` and the CLI help on this machine.

| ID | Agent | Model | Effort | Why |
|---|---|---|---|---|
| C0 | Codex | `gpt-6.1-sol` | medium | Well-specified tooling work with a crisp command-based done-check. Codex handles package and config setup reliably. |
| C1 | Claude | `claude-sonnet-5-5` | medium | Short Python script with a geodesy detail (corner order, rotation). Sonnet handles it cheaply; the done-check catches a wrong transform. |
| C2 | Claude | `claude-haiku-4-5-20251001` | (none) | Mechanical fixture generation against a fixed type. Cheapest model is enough; `tsc` catches drift. |
| C3a | Mahesh | — | — | Shared files. Hand-written so no agent owns them. |
| C4 | Claude | `claude-opus-5-5` | high | deck.gl layer design, MapLibre interleaving and coordinate alignment carry the most architecture risk in role C. |
| C5 | Codex | `gpt-6.1-sol` | high | Self-contained component with a hard perf target and a measurable test. |
| C6 | Claude | `claude-sonnet-5-5` | medium | Standard React components rendering given data. |
| C7 | Codex | `gpt-6.1-sol` | high | Performance-critical animation loop and layer tuning against an fps number. |
| C8 | Claude | `claude-sonnet-5-5` | medium | Small UI with adapter calls. |
| C9 | Claude | `claude-sonnet-5-5` | medium | Only if time remains. |
| C10 | Mahesh + Claude interactive | `claude-opus-5-5` | high | Integration debugging across A/B/D code needs a human in the loop. Run interactively, not as a swarm job. |
| C11 | Mahesh | — | — | Visual judgement on real hardware. |
| Review of Codex branches | Claude | `claude-sonnet-5-5` | medium | Other-vendor review, read-only (`--permission-mode plan`). |
| Review of Claude branches | Codex | `gpt-6.1-sol` (config default) | medium | `codex review --base c/ui`. |

Fable 5.1 (`claude-fable-5-1`) is not assigned. It stays as a spare vendor-internal fallback when Opus stalls on C4 or C10.

---

## 4. Parallel schedule, worktrees and ownership

Worktrees sit next to the repo so `npm` installs do not collide. Each one needs its own `npm ci` (about 1 minute; run it in the background).

| Window | Parallel agents | Worktree (`../ut-<id>`) and branch | Owns (may write) |
|---|---|---|---|
| Pre-event, step 1 | C0 alone | `../ut-c0` · `c/c0-scaffold` | root config files, `src/contracts.ts`, `src/main.tsx`, `src/index.css` |
| Pre-event, step 2 | C1 ∥ C2 (C2 starts with OSM, reads C1 output when ready) | `../ut-c1` · `c/c1-base`; `../ut-c2` · `c/c2-fixtures` | C1: `tools/`, `public/base/`. C2: `src/ui/__fixtures__/` |
| 13:30–15:00 | C4 ∥ C5 ∥ C6 | `../ut-c4` · `c/c4-map`; `../ut-c5` · `c/c5-ranking`; `../ut-c6` · `c/c6-cockpit` | C4: `src/ui/map/`, `e2e/map.spec.ts`. C5: `src/ui/ranking/`, `e2e/ranking.spec.ts`. C6: `src/ui/cockpit/`, `e2e/cockpit.spec.ts` |
| 15:00–16:30 | C7 ∥ C8 | `../ut-c7` · `c/c7-sim`; `../ut-c8` · `c/c8-whatif` | C7: `src/ui/map/simLayers.ts`, `src/ui/controls/`, `src/ui/perf/`, `e2e/perf.spec.ts`. C8: `src/ui/whatif/`, `src/ui/compare/`, `e2e/whatif.spec.ts` |
| 17:00–18:00 | C10 (interactive) | main checkout · `c/c10-integrate` | `src/ui/adapters/` |

**Read-only for every agent:** `src/contracts.ts`, `src/ui/state/store.ts`, `src/ui/adapters/types.ts`, `src/ui/App.tsx`, `package.json`, `package-lock.json`, `tailwind`/theme tokens in `src/index.css`, everything outside `src/ui/`. If an agent needs a new dependency or store field, it writes `// TODO(subagent): need X` and stops that part. Mahesh adds it on `main` and tells the agent to rebase with `ruddr steer`.

**Mounting:** each component exports one default component (`<MapView/>`, `<RankingPanel/>`, `<Cockpit/>`, `<WhatIfBar/>`). `App.tsx` already imports all four from day one with stub files committed in C3a, so merges never touch `App.tsx`.

**Merge order and who merges:** Mahesh merges C branches into his integration branch `c/ui` in the order C0 → C1 → C2 → C3a → C5 → C6 → C4 → C8 → C7 (cheapest-to-verify first, map last because it is the slowest to review). After each merge he runs `npm ci && npm run build && npm test -- --run && npm run e2e`. D merges `c/ui` into `main` (§12 of the master plan) at 15:00 and at 17:00.

---

## 5. Prompts

### 5.1 Shared preamble (prepend to every brief)

```text
Project: UrbanTwin Market-Sim, a Vite + React + TypeScript app with deck.gl over MapLibre.
You work in a git worktree on branch {BRANCH}. Other agents edit other folders of the same project
at the same time. Read IMPLEMENTATION_PLAN.md §5 (data contract) and §7 role C before editing.

Contract rules:
- Import types only from src/contracts.ts. Do not add, rename or make optional any field.
  If you need data the contract lacks, write `// TODO(subagent): contract needs <field>` and work around it.
- Never hard-code a score, percentage or criterion value in UI code. Render values from the data.
- Read app state only through src/ui/state/store.ts and data only through src/ui/adapters/types.ts.

Scope fence: you may create or edit files ONLY under {ALLOWED}. Do not modify files outside {ALLOWED}.
Do not edit package.json, package-lock.json, src/contracts.ts, src/ui/App.tsx, src/ui/state/*,
src/ui/adapters/*, src/index.css. Do not add dependencies. Do not touch .scratch/ (controller files).

Styling: Tailwind utility classes only, using the existing tokens in src/index.css
(dark theme, persona colours senior #8b5cf6, vendor #f97316, commuter #3b82f6, retailer #9ca3af).
No new CSS files, no other UI library.

Secrets: never read, print or write .env or any API key. No network calls except to localhost.

Commit policy: leave all changes uncommitted. The orchestrator reviews and commits.
Dependencies are already installed (npm ci ran). The sandbox may block network; that is expected.
```

### 5.2 Task blocks (append to the preamble, then append the Ruddr handoff block verbatim)

**C0 · scaffold (Codex).** `{ALLOWED}` = repo root config files, `src/main.tsx`, `src/index.css`, `src/contracts.ts`, `src/ui/`, `e2e/`, empty `.gitkeep` folders. This brief overrides the preamble's ban on `package.json`.

```text
Goal: scaffold the app. Use npm (no pnpm). Vite + React + TS, Tailwind, Vitest (jsdom), @playwright/test,
maplibre-gl, deck.gl packages @deck.gl/core @deck.gl/layers @deck.gl/geo-layers @deck.gl/aggregation-layers
@deck.gl/mapbox @deck.gl/react, all pinned to ONE exact identical version (no ^ or ~).
Paste the TypeScript block from IMPLEMENTATION_PLAN.md §5 into src/contracts.ts verbatim with a header
comment "DRAFT until 13:20 freeze". Create src/rank src/sim src/score server with .gitkeep.
Scripts: dev, build (tsc -b && vite build), test (vitest), e2e (playwright test).
Playwright config: baseURL http://localhost:5173, webServer = npm run dev, chromium only.
src/index.css: Tailwind import plus CSS variables for the dark theme and the four persona colours listed above.
Done-check (run all): npm ci; npm run build; npm test -- --run; npm ls @deck.gl/core (exactly one version).
```

**C1 · base assets (Claude Sonnet).** `{ALLOWED}` = `tools/`, `public/base/`.

```text
Goal: tools/base_assets.py produces browser assets from datasets/.
1. For each datasets/dop20/*.jpg and datasets/alkis/*.png: parse minx_miny_maxx_maxy (EPSG:25832) from the name,
   resize to 2100x2100 (JPEG q=80 / PNG), write to public/base/, and convert the 4 corners with
   pyproj Transformer.from_crs(25832, 4326, always_xy=True).
   Write public/base/dop20.json and alkis.json as [{url, bounds: [[lng,lat] BL, TL, TR, BR]}].
2. From datasets/osm/altstadt.json, building ways -> public/base/buildings-osm.json as
   [{polygon: [[lng,lat],...], h}] with h = tags.height, else building:levels*3, else 9. Round coords to 6 dp.
Done-check: uv run --with pyproj --with pillow python tools/base_assets.py; du -sh public/base (< 15 MB);
add tools/check_base.py that asserts 11.07773,49.45095 lies inside exactly one dop20 quadrant and
that buildings count >= 3000; run it.
```

**C2 · fixtures (Claude Haiku).** `{ALLOWED}` = `src/ui/__fixtures__/`.

```text
Goal: realistic fixtures that type-check against src/contracts.ts.
Write src/ui/__fixtures__/gen.ts (run with npx tsx or bun) that reads datasets/osm/altstadt.json and writes:
- candidates.json: 18 Candidate objects. Include the 3 benchmarks (kind 'benchmark': Hauptmarkt 49.45393,11.07744;
  Lorenzkirche 49.45095,11.07773; Kaufhof ~49.4490,11.0800). At least 5 have passedFilter=false with a rejectReason
  ("area < 800 m²", "no stop within 400 m", "no van route within 80 m"). Polygons are small quads around real OSM squares.
- result-<id>-<scenario>.json for 3 shortlist ids x SUNNY_SAT, RAINY_SAT: SimulationResult with all 3 TimeSlices,
  >= 100 trips whose paths follow OSM footway/pedestrian way geometry with increasing tSec, heat points, bottlenecks.
  Values are deterministic from a seeded RNG (mulberry32, seed 42). Label the file header "FIXTURE - not engine output".
- brief.json: one Brief.
Write fixtures.test.ts that imports every JSON with the contract types (satisfies) and asserts trips.length >= 100.
Done-check: npm test -- --run src/ui/__fixtures__ ; npx tsc --noEmit.
```

**C4 · map (Claude Opus).** `{ALLOWED}` = `src/ui/map/`, `e2e/map.spec.ts`.

```text
Goal: src/ui/map/MapView.tsx (default export) renders MapLibre with an empty background style and
deck.gl via @deck.gl/mapbox MapboxOverlay ({interleaved: true}). Initial view 49.4525,11.0775 zoom 16 pitch 50.
Layers (one file per layer factory under src/ui/map/layers/): BitmapLayer per entry in /base/dop20.json using its
4-corner bounds; extruded buildings from /data/buildings.json, falling back to /base/buildings-osm.json on 404;
candidate PolygonLayer coloured by rank from the store (rejected = grey 40% alpha, pickable, tooltip shows name and
rejectReason); bollards ScatterplotLayer from OSM barrier=bollard nodes (precompute once, keep in memory).
Click on a candidate sets selectedId via the store. Show the attribution text from IMPLEMENTATION_PLAN.md §3.
Memoize layers on their data so a weight change does not rebuild static layers.
Done-check: npm run build; npm run e2e -- map.spec.ts (spec: no console errors, canvas present, hover a rejected
candidate shows the reason, saves e2e/__shots__/map.png).
```

**C5 · ranking (Codex).** `{ALLOWED}` = `src/ui/ranking/`, `e2e/ranking.spec.ts`.

```text
Goal: src/ui/ranking/RankingPanel.tsx (default export) and applyWeights.ts.
applyWeights(criteria: Weights, w: Weights) returns the weighted sum; normalize(w) renormalizes to sum 1.
Bars sorted by score from store.results[*].criteria and store.weights; 5 sliders (accessibility, footfall, fairness,
localBusiness, walkability) and 3 presets exactly as IMPLEMENTATION_PLAN.md §6. Guard badge when any persona score < 40.
Use React keys by candidate id and CSS transform transitions for reordering. No layout thrash: no
getBoundingClientRect per frame.
Done-check: npm test -- --run src/ui/ranking (unit tests for normalize, sorting, guard);
npm run e2e -- ranking.spec.ts measuring input->DOM reorder with MutationObserver, median of 20 < 100 ms.
```

**C6 · cockpit (Claude Sonnet).** `{ALLOWED}` = `src/ui/cockpit/`, `e2e/cockpit.spec.ts`.

```text
Goal: src/ui/cockpit/Cockpit.tsx (default export): consensus dial (min and mean of the 4 PersonaResult.score of the
selected candidate), 4 persona cards (score, topFriction chip, verdict or "verdict pending"), brief panel
(why, comparisons, losers), button "Apply Claude mitigation" -> SimClient.run(selectedId, scenario,
brief.losers.map(l => l.mitigation), seed) then store update, button "Export council brief" -> Blob download
council-brief.md with brief.councilBriefMd.
Done-check: npm run e2e -- cockpit.spec.ts (cards show fixture scores, download text equals councilBriefMd,
Apply triggers exactly one adapter call and re-renders).
```

**C7 · sim layers and perf (Codex).** `{ALLOWED}` = `src/ui/map/simLayers.ts`, `src/ui/controls/`, `src/ui/perf/`, `e2e/perf.spec.ts`.

```text
Goal: export buildSimLayers(result, slice, timeSec) returning TripsLayer (getPath [lng,lat], getTimestamps tSec,
persona colours, trailLength 120, currentTime timeSec), HeatmapLayer from bySlice[slice].heat, bottleneck
ScatterplotLayer (radius by severity, tooltip cause+time), kiosk IconLayer or ScatterplotLayer when
result.mitigations is non-empty. src/ui/controls/TimeControls.tsx: slice slider (3 stops) and play/pause; one
requestAnimationFrame loop updates timeSec. Only the TripsLayer changes per frame; keep data arrays stable
(useMemo) so deck.gl does not re-upload buffers. src/ui/perf/fps.ts writes a rolling 1 s fps to window.__fps when
location.search has perf=1. MapView integration: the orchestrator adds one line; export what it needs and document it.
Done-check: npm run build; npm run e2e -- perf.spec.ts --headed (median __fps over 10 s >= 55 with 100 trails).
```

**C8 · what-if and compare (Claude Sonnet).** `{ALLOWED}` = `src/ui/whatif/`, `src/ui/compare/`, `e2e/whatif.spec.ts`.

```text
Goal: WhatIfBar.tsx (default export): Sunny / Rainy / Christmas buttons set store.scenario and call SimClient.run
for every shortlisted candidate (passedFilter true, plus benchmarks), with a spinner and a disabled state while
running. Missing fixture for a scenario shows "scenario not available offline". Compare.tsx: two selected candidates
side by side, 5 criteria and 4 persona scores.
Done-check: npm run e2e -- whatif.spec.ts.
```

**Cross-review prompt (other vendor, read-only).**

```text
Review the diff of branch {BRANCH} against main for: fields not present in src/contracts.ts, hard-coded scores,
files edited outside {ALLOWED}, new dependencies, secrets or .env access, deck.gl layers rebuilt every render,
and broken done-check specs. Report findings with file:line. Do not edit files.
```

### 5.3 Ruddr handoff block

Append the "Work autonomously to completion … Handoff report" block from `~/.claude/skills/ruddr-delegate/SKILL.md` verbatim to every brief.

---

## 6. Orchestrator loop

### 6.1 One-time setup (pre-event)

```bash
cd "/run/media/maheshk/New Volume/MK-solutions/claude_imapct_lab"
echo ".scratch/" >> .git/info/exclude
ruddr models add claude claude-sonnet-5-5 --label "Claude Sonnet 5.5"
ruddr models --json | grep -c sonnet-5-5          # expect 1
mkdir -p .scratch/c-swarm/{c0,c1,c2,c4,c5,c6,c7,c8}
# brief.md per agent = preamble + task block + handoff block
```

### 6.2 Launch (example: the 13:30 wave)

```bash
R="/run/media/maheshk/New Volume/MK-solutions/claude_imapct_lab"
for t in c4-map c5-ranking c6-cockpit; do
  git -C "$R" worktree add "$R/../ut-${t%%-*}" -b "c/$t" c/ui
done
( cd "$R/../ut-c4" && npm ci ) & ( cd "$R/../ut-c5" && npm ci ) & ( cd "$R/../ut-c6" && npm ci ) & wait

ruddr run --detach --provider claude --model claude-opus-5-5 --effort high \
  --cwd "$R/../ut-c4" --sandbox workspace-write --turn-timeout 75m \
  --prompt-file "$R/.scratch/c-swarm/c4/brief.md" --state-dir "$R/.scratch/c-swarm/c4/run" &
ruddr run --detach --provider codex --model gpt-6.1-sol --effort high \
  --cwd "$R/../ut-c5" --sandbox workspace-write --turn-timeout 60m \
  --prompt-file "$R/.scratch/c-swarm/c5/brief.md" --state-dir "$R/.scratch/c-swarm/c5/run" &
ruddr run --detach --provider claude --model claude-sonnet-5-5 \
  --cwd "$R/../ut-c6" --sandbox workspace-write --turn-timeout 60m \
  --prompt-file "$R/.scratch/c-swarm/c6/brief.md" --state-dir "$R/.scratch/c-swarm/c6/run" &
wait
ruddr status --root "$R/.scratch/c-swarm"          # every run must show active
```

Notes:
- Always pass `--sandbox workspace-write`. Ruddr defaults to `danger-full-access`, and `~/.codex/config.toml` also sets full access with `approval_policy = "never"`.
- `workspace-write` under Codex blocks network, so `npm ci` runs from the orchestrator before launch.
- Playwright starts a dev server, and parallel worktrees would collide on port 5173. C0 makes `playwright.config.ts` read `process.env.PORT ?? 5173` for both `baseURL` and `webServer` (`vite --port $PORT --strictPort`). Each agent runs its specs with `PORT=517N`, where N is the digit of its ID (C4 → 5174 … C8 → 5178).

**Fallback without Ruddr** (not steerable):

```bash
# Codex
codex exec -C "$R/../ut-c5" -m gpt-6.1-sol -c model_reasoning_effort="high" -s workspace-write \
  --json -o "$R/.scratch/c-swarm/c5/last.md" - < "$R/.scratch/c-swarm/c5/brief.md" > "$R/.scratch/c-swarm/c5/events.jsonl"
# Claude (cd into the worktree first; -p reads the prompt from stdin)
cd "$R/../ut-c6" && claude -p --model claude-sonnet-5-5 --effort medium --permission-mode acceptEdits \
  --max-budget-usd 4 --output-format json < "$R/.scratch/c-swarm/c6/brief.md" > "$R/.scratch/c-swarm/c6/out.json"
```

`codex exec --worktree` and `claude -w <name>` also create managed worktrees, but they pick their own paths. The plan uses explicit `git worktree add` so the merge commands stay predictable.

### 6.3 Monitor and steer

```bash
ruddr tui --root "$R/.scratch/c-swarm"                         # live view in a side terminal
ruddr peek --root "$R/.scratch/c-swarm"                         # last trace lines per agent
ruddr wait --root "$R/.scratch/c-swarm" --any --timeout 10m     # returns when the next one finishes
ruddr steer --state-dir "$R/.scratch/c-swarm/c5/run" "store.ts now has field X; rebase on c/ui"
ruddr interrupt --state-dir "$R/.scratch/c-swarm/c4/run"        # wrong premise
```

Check every agent in its first 2 minutes (`peek` shows file reads, not an error loop), then every 10 minutes. A silent `trace.log` for more than 10 minutes counts as a stall.

### 6.4 Verify independently (never trust the handoff report)

For each finished agent:

```bash
cd "$R/../ut-c5"
git status --short                                   # only files under {ALLOWED}?
git diff --name-only | grep -vE '^(src/ui/ranking/|e2e/ranking.spec.ts)' && echo "SCOPE VIOLATION"
git diff | grep -nE 'sk-ant|ANTHROPIC|process\.env\.[A-Z_]*KEY' && echo "SECRET?"
npx tsc --noEmit && npm test -- --run && PORT=5175 npm run e2e -- ranking.spec.ts
```

Then run the cross-review from the other vendor. `codex review --help` lists `--base <BRANCH>` and a positional `[PROMPT]`; if this version rejects the combination, drop the prompt and keep `--base`.

```bash
# Claude-written branch reviewed by Codex
git -C "$R/../ut-c6" add -A && git -C "$R/../ut-c6" commit -m "c6: cockpit"
cd "$R/../ut-c6" && codex review --base c/ui "$(cat "$R/.scratch/c-swarm/review.md")"
# Codex-written branch reviewed by Claude, read-only
cd "$R/../ut-c5" && git diff c/ui... | claude -p --model claude-sonnet-5-5 --permission-mode plan \
  --max-budget-usd 1 "$(cat "$R/.scratch/c-swarm/review.md")"
```

Mahesh fixes or steers on any real finding, then merges:

```bash
git -C "$R" switch c/ui && git -C "$R" merge --no-ff c/c5-ranking
cd "$R" && npm ci && npm run build && npm test -- --run && npm run e2e
git -C "$R" worktree remove "$R/../ut-c5"
```

### 6.5 Failure policy

| Situation | Action |
|---|---|
| Agent stalls (no trace for 10 min) | `ruddr interrupt`, then `ruddr run --resume-thread <id>` with a brief that states what it already learned. |
| Done-check fails after the agent claims success | `ruddr steer` with the verbatim failing output. This is attempt 2. |
| Fails twice | Re-scope (cut the Should part), **or** switch vendor with the same brief plus the two failure logs, **or** Mahesh does it by hand if it is under 30 minutes of work. After 15:00, prefer by hand. |
| Scope violation | Discard the out-of-scope files with `git checkout -- <file>` and steer once. A second violation ends the run. |
| Agent edits `contracts.ts` | Revert and steer. Contract changes go only through B and D at the 13:20 freeze. |

### 6.6 Budget

Codex runs use the ChatGPT-plan quota of the `codex` login (the plan tier was not checked here). Claude runs cost API or plan usage. Caps below apply through `--max-budget-usd` when an agent runs via `claude -p`. Ruddr has no budget flag, so Mahesh watches Claude runs in `ruddr tui` and interrupts at the time limit.

| Agent | Est. tokens (in+out) | Cap |
|---|---|---|
| C0 Codex high | 1.5 M | 45 min |
| C1 Sonnet | 0.6 M | $3 |
| C2 Haiku | 0.8 M | $1 |
| C4 Opus high | 3 M | $15, 75 min |
| C5 Codex high | 1.5 M | 60 min |
| C6 Sonnet | 1 M | $4 |
| C7 Codex high | 2 M | 60 min |
| C8 Sonnet | 0.8 M | $3 |
| Cross-reviews (×7) | 0.3 M each | $1 each (Claude) |
| C10 Opus interactive | 3 M | $15 |
| **Total Claude** | | **≈ $50 hard ceiling** |

---

## 7. Integration at 17:00

| Step | What | Check |
|---|---|---|
| 1 | B exports a worker entry (`src/sim/worker.ts`) that takes `{candidateId, scenario, mitigations, seed}` and posts a `SimulationResult`. C writes `adapters/worker.ts` with `new Worker(new URL('../../sim/worker.ts', import.meta.url), {type:'module'})`. | `demo.spec.ts` with `?data=worker` gets 3 results in < 1.5 s each. |
| 2 | D exposes `/api/brief` (POST JSON in, `Brief` out). Vite `server.proxy` points `/api` to D's server port. C writes `adapters/http.ts`. On error or > 6 s it falls back to D's cached brief, then to the fixture brief, and shows a "cached" chip. | Unplug the network: the brief still renders with the chip. |
| 3 | Replace `applyWeights` with D's score export, keeping the same signature through a one-line re-export. | `ranking.spec.ts` still < 100 ms. |
| 4 | A's `public/data/candidates.json` replaces the fixture candidates. | Rejected candidates appear grey with A's reasons. |
| 5 | Full pitch path (§11) 3 times in a row. | 18:00 freeze gate. |

**Fallbacks.** If B is late, the UI stays on `?data=fixtures` for simulation and uses A's real candidates; trails come from fixtures labeled "fixture". If D is late, the UI shows the fixture brief with the "cached" chip and computes MarketScore with `applyWeights`. In both cases the URL flag switches back without a rebuild.

---

## 8. Risks specific to multi-agent UI work

| Risk | Mitigation |
|---|---|
| Agents invent contract fields | `contracts.ts` is read-only; `npx tsc --noEmit` is in every done-check; fixtures use `satisfies`; cross-review checks for unknown fields; `TODO(subagent)` is the only allowed escape. |
| Conflicting Tailwind or theme choices | Theme tokens and persona colours live in `src/index.css` from C0 and are read-only; the preamble lists the hex values; no new CSS files or UI libraries. |
| deck.gl version mismatch | All `@deck.gl/*` pinned to one exact version in C0; agents cannot edit `package.json`; `npm ls @deck.gl/core` in the merge check. |
| Flaky perf measurements | FPS is measured in-app over 10 s, headed, on the demo laptop, median of 3 runs; headless Chromium numbers are ignored. Ranking latency uses the median of 20 changes. |
| Agents commit secrets | Agents never commit; the preamble forbids `.env`; `.env` is in `.gitignore` from C0; the merge check greps the diff for keys; Codex runs in `workspace-write` instead of the config default `danger-full-access`. |
| Port and `npm` collisions between worktrees | One worktree per agent, `npm ci` per worktree, `PORT=517N` per spec run. |
| Merge conflicts in shared files | Shared files are hand-written by Mahesh and read-only for agents; `App.tsx` mounts stubs from the start. |
| Misaligned aerial photo | 4-corner bounds from pyproj; C1 check asserts Lorenzkirche falls inside the right quadrant; Mahesh inspects `map.png`. |
| Agent spends the window on Stretch work | C9 starts only if C4–C8 are merged by 16:30. |
