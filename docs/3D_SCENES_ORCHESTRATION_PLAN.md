# 3D Presentation Scenes: Implementation and Agent Orchestration Plan

UrbanTwin: Market-Sim · Claude Impact Lab #2 · Build window 13:00–20:00
Source of truth for scope, contract and gates: `IMPLEMENTATION_PLAN.md` (§5 contract, §6 scoring, §7 roles, §10 gates, §11 pitch). Role C dispatch conventions: `docs/C_ROLE_ORCHESTRATION_PLAN.md`.

This plan covers two scripted 3D scenes for the final demo and the recorded fallback video:

- **Scene 1 "Lorenzkirche 05:30 → 11:30".** The camera flies into the 3D Altstadt (LoD2 buildings, DOP20 draped on DGM1 terrain). Vendor Markus is blocked at a real OSM bollard and the vendor score drops. At 11:30 U1 commuter waves from GTFS arrive and the commuter score is high.
- **Scene 2 "Kaufhof, rainy Saturday".** Oma Helga routes through elevators around steps on sheltered, flat edges. Markus reaches the rear loading point. Lukas runs out of lunch time. The presenter presses **Apply Claude mitigation** and the engine reruns live.

**Rule zero applies to every frame.** Every number on screen comes from a `SimulationResult`, `Brief`, `arrivals.json` or the score function. Scene files hold camera keyframes, layer toggles and caption templates with binding paths. They hold no score, percentage or count.

---

## 0. Ground truth checked on this machine (2026-10-05)

| Item | Finding | Consequence |
|---|---|---|
| Repo | `main` at `dcac2bb`. No `package.json`, `src/`, `public/` or `prep/` yet. | Scenes build on the C0 scaffold and on A's `prep/`. Nothing in this plan starts before C0 merges. |
| `datasets/lod2/` | 4 CityGML 1.0 tiles, 525 MB, 26,012 `bldg:Building` elements (5,379 / 6,472 / 7,401 / 6,760). CRS `ETRS89_UTM32*DE_DHHN2016_NH`, absolute heights (for example 299.99 m ground). No `app:Appearance`, so no facade textures. | Parse with streaming `lxml.etree.iterparse`. Clip to the Altstadt bbox. Colour buildings flat. Heights share the DHHN2016 datum with DGM1, so one base offset aligns both. |
| `datasets/dgm1/` | 9 GeoTIFF tiles, each 1000 × 1000 float32 (1 m). | Mosaic to 3 × 3 km and encode as a Terrarium PNG for deck.gl `TerrainLayer`. |
| `datasets/dop20/` | 4 JPEG quadrants, 4200 × 4200 px, bbox in the filename (EPSG:25832). | Warp into the same lng/lat grid as the terrain so the texture and mesh share bounds. |
| GDAL tools | `gdalinfo`, `ogr2ogr`, `citygml-tools` and `py3dtiles` are not installed. `uv`, `ffmpeg` and Playwright Chromium (`chromium-1243`) are installed. | The pipeline uses `uv run --with lxml --with numpy --with pyproj --with pillow --with tifffile` only. No GDAL dependency. |
| OSM bollards | Nearest bollard to the Lorenzkirche station point is node `6394611280` at about 95 m; the next ones sit at about 256 m. Nearest to the Kaufhof estimate is node `876466605` at about 119 m. | The scene shows the bollard that the engine reports in its `BOLLARD_BLOCKAGE` bottleneck. The OSM node IDs above serve only as a sanity check. |
| OSM Lorenzkirche | Stop node `60115950`; subway entrances `291107587`, `312496655`, `317336138`. | Commuter trips start at these entrances (B's origins). |
| OSM Kaufhof | No element carries a Kaufhof or Galeria name. Way `144721687` (`building=retail`) is an unverified candidate. | A must confirm the footprint and the rear loading point by hand (master plan §9). This is blocker B1 in §8. |
| OSM shelter and elevators | 591 ways carry `covered` or `tunnel`. One `highway=elevator` lies within 300 m of Lorenzkirche, two within 300 m of the Kaufhof estimate. | The Kaufhof interior has no OSM footways. A adds synthetic interior edges (`sheltered`, flat, elevator) to `graph.json`. |
| GTFS | `stops.txt` holds `de:09564:511:11:1` and `:2` for "Nürnberg Lorenzkirche". | A's `arrivals.json` filters U1 Saturday arrivals at these stop IDs. |
| `codex` | `codex-cli 0.160.0`; `~/.codex/config.toml` sets `model = "gpt-6.1-sol"`, `model_reasoning_effort = "medium"`, full access, `approval_policy = "never"`. | Pass `-s workspace-write` or `--sandbox workspace-write` on every run. |
| `claude` | `2.1.289`; `--effort` accepts `low, medium, high, xhigh, max`. | Claude runs set effort explicitly. |
| `ruddr` | `0.6.3` (0.6.4 available; do not update on event day). `ruddr models --json` lists Codex `gpt-6.1-sol` (efforts up to `ultra`), `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-*`, and **`gpt-6-astra` as the Codex default**. Claude: `claude-opus-5-5` (default), `claude-sonnet-5-5` (added from config), `claude-fable-5-1`. Claude entries list no efforts. | Every `ruddr run --provider codex` must pass `--model gpt-6.1-sol`, or Ruddr silently selects the excluded `gpt-6-astra`. If Ruddr rejects `--effort` for a Claude model, the fallback is `claude -p` with `--effort`. |

### Models used

| Vendor | Model | Role in this plan |
|---|---|---|
| OpenAI (Codex) | `gpt-6.1-sol` | Heavy TypeScript and Python implementation: CityGML parsing, terrain warping, deck.gl layers, the live rerun, engine scene properties, cross-review of Claude branches. It is the newest Codex model in the catalog and the only one that offers `xhigh`/`ultra`. |
| Anthropic | `claude-opus-5-5` | Architecture: the scene director, binding contract, integration with the real engine, rule-zero audit design. |

Excluded: `gpt-6-astra` (by instruction), older generations (`gpt-6-sol`, `gpt-5.6-*`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, Haiku), and the `opencode`, `pi` and `droid` providers.

---

## 1. Architecture fit

```mermaid
flowchart LR
    subgraph prep ["prep/scene3d (A, Python, pre-event)"]
        L[lod2_buildings.py] --> BJ[public/data/buildings3d.json]
        T[terrain.py] --> TP[public/data/terrain/*.png + terrain.json]
        G[graph.json checks] --> GJ[public/data/graph.json]
        A2[arrivals.json]
    end
    subgraph ui ["src/ui/scenes (C)"]
        D[director.ts<br/>timeline + camera] --> V[SceneView.tsx<br/>standalone DeckGL]
        S1[scene1.ts] --> D
        S2[scene2.ts] --> D
        H[SceneHUD.tsx<br/>bound captions]
    end
    W[src/sim worker (B)] -->|SimulationResult| D
    BR[/api/brief (D)/] -->|Brief.losers| D
    D -->|SimClient.run with mitigations| W
    V --> REC[video/record.ts (A)<br/>frame-stepped capture]
```

Design decisions:

1. **Scene mode uses a standalone `<DeckGL>` without MapLibre.** The base map is the DOP20 texture on the terrain mesh, so MapLibre adds nothing. `TerrainLayer` plus `@deck.gl/extensions` `TerrainExtension` drapes trips, markers and candidate outlines onto the terrain. This avoids the unverified combination of `TerrainExtension` with `MapboxOverlay` interleaved mode. The normal cockpit map keeps the C4 MapLibre setup. `@deck.gl/extensions` must be added in C0 at the same pinned deck.gl version.
2. **Scenes are data, the director is code.** `scene1.ts` and `scene2.ts` export `SceneDef` objects: keyframes (`t`, `viewState`, `transitionMs`), `simClock` ranges, `layers` toggles, `captions` with template strings such as `"Vendor {personas.vendor.score}"` and `follow` targets. The director resolves each `{path}` against the active `SimulationResult` at render time.
3. **The director owns time.** It exposes `window.__scene = { step(dtMs), seek(tMs), play(), pause(), state }`. Live playback calls `step` from one `requestAnimationFrame` loop. The recorder calls `step(1000/30)` per frame, so the video is smooth on any laptop.
4. **Heroes are selected by rule, not by ID.** "Markus" is the vendor trip whose last point lies nearest the engine's `BOLLARD_BLOCKAGE` bottleneck (scene 1) or the loading point (scene 2). "Oma Helga" is the earliest senior trip whose path passes within 5 m of an elevator node. "Lukas" is the commuter trip with the longest duration in the 11:30 window. The rules live in `src/ui/scenes/heroes.ts` with Vitest coverage.
5. **The UI computes no criterion.** It formats engine values. The before/after delta in scene 2 subtracts two engine values and labels both sources.
6. **Scenes mount behind a URL flag.** `?scene=1` or `?scene=2` renders `SceneView` instead of `App`'s grid. `?scene=N&data=fixtures` keeps the fixture path alive. This needs one line in `src/main.tsx`, which Mahesh adds by hand.

### Contract questions to settle at the 13:20 freeze

The scenes need these facts. Each one is either already implied by §5 or a small additive change that B and D must approve.

| Q | Need | Proposal |
|---|---|---|
| Q1 | The time base of `trips[].path[i][2]` (`tSec`) is unspecified. | Seconds since 00:00 local time. 05:30 = 19800. |
| Q2 | Scene 2 needs to know whether a commuter dropped out. `trips` carries no outcome. | Add optional `outcome?: 'served' \| 'dropped'` to the trip object. Fallback without it: show `personas.commuter.droppedOut` and `topFriction` and pick Lukas by longest duration. |
| Q3 | Trips have no z. Paths drawn at z = 0 sit under the terrain. | No contract change. `TerrainExtension` drapes 2D paths. |
| Q4 | Kiosk positions after a mitigation. `mitigations` is `string[]`. | Engine encodes kiosk nodes as `"kiosk:<lng>,<lat>"` strings, or adds optional `kiosks?: [number, number][]`. B decides. |

---

## 2. Data pipeline (A owns `prep/scene3d/` and `public/data/`; agents write on A's branch)

All scripts run with `uv run --with lxml --with numpy --with pyproj --with pillow --with tifffile python prep/scene3d/<script>.py` and finish before 13:00.

### P1 · LoD2 CityGML → `buildings3d.json` (+ optional roof GLB)

1. Stream each `datasets/lod2/*.gml` with `iterparse` on `bldg:Building` and clear elements after use.
2. For each building read `bldg:measuredHeight`, `bldg:roofType`, the `bldg:GroundSurface` ring (fallback: the lowest-z ring of the solid), and the ground z as the minimum ring z.
3. Keep buildings whose centroid lies inside the Altstadt bbox `649600,5478800 – 651700,5480900`.
4. Transform rings with `pyproj.Transformer.from_crs(25832, 4326, always_xy=True)`, round to 6 dp, simplify rings to 0.3 m tolerance.
5. Write `public/data/buildings3d.json` as `[{id, polygon:[[lng,lat,zBase]], h, roof}]` with `zBase = groundZ − baseElevation` (from P2's `terrain.json`).
6. Stretch: export roof surfaces (`bldg:RoofSurface` triangulated with ear clipping) per tile to `public/data/roofs.glb` for a `ScenegraphLayer`. Ship only if file size stays below 15 MB and fps holds. Extruded footprints are the default; 3D Tiles are out of scope because no tiler is installed and deck.gl reads glTF directly.

**Acceptance:** at least 7,085 buildings inside the bbox (the full LoD2 count for this bbox); file below 12 MB; the building containing the Lorenzkirche towers (about `49.4511, 11.0782`) has `h ≥ 70`; the script finishes in under 4 minutes; a check script prints the 5 tallest buildings with names from OSM overlap for a human glance.

### P2 · DGM1 + DOP20 → terrain and texture

1. Mosaic the 9 DGM1 tiles into a 3000 × 3000 m UTM grid with `tifffile` + `numpy`.
2. Define a regular WGS84 grid that covers the Altstadt bbox at about 1 m (`~0.0000139°` lng, `~0.000009°` lat). For each target pixel, inverse-project to UTM and sample bilinearly. This removes the 1.5° grid convergence that would shift an axis-aligned `bounds` by several metres.
3. Set `baseElevation = floor(min elevation in bbox)` and encode `elevation − baseElevation` as Terrarium RGB into `public/data/terrain/elevation.png` (2048 px on the long side).
4. Warp the 4 DOP20 quadrants into the same lng/lat grid and write `public/data/terrain/texture.jpg` (4096 px, q = 82).
5. Write `public/data/terrain/terrain.json` with `{bounds:[w,s,e,n], baseElevation, elevationDecoder}`.
6. Write `public/data/terrain/heightgrid.bin` (Float32, 4 m) for the director's camera altitude clamp.

**Acceptance:** for 200 random LoD2 buildings, the median absolute difference between `groundZ` and the terrain sample at the footprint centroid is below 0.5 m; the Lorenzkirche station point falls inside `bounds`; total `public/data/terrain/` size is below 20 MB; a 1600 × 900 render (S1 gate) shows building bases flush with the aerial photo at Lorenzkirche and Kaufhof.

### P3 · `graph.json` scene properties

A already builds `graph.json` (master plan §7 A5). The scenes depend on these edge and node properties: `steps`, `elevator`, `sheltered`, `vehicleAllowed`, `surface`, `slope`, bollard node references, synthetic Kaufhof interior edges, and the Kaufhof rear loading node.

**Acceptance (`prep/scene3d/check_scene_graph.py`):**
- The shortest vehicle-legal route from the city ring to the Lorenzkirche plaza either does not exist or ends more than 80 m away, and the first blocked edge touches an OSM `barrier=bollard` node.
- A vehicle-legal route reaches the Kaufhof loading node and ends within 80 m of the stall polygon.
- A step-free route exists from a U-Bahn entrance to the Kaufhof stalls, it uses at least one `elevator` edge, and its sheltered length share is printed.
- Every edge has all listed properties (no `undefined`).

### P4 · GTFS arrival waves

A's `arrivals.json` must include Saturday U1 arrivals at Lorenzkirche stop IDs `de:09564:511:11:1` and `:2` with times, so scene 1 can draw arrival ticks.

**Acceptance:** the helper prints the Saturday U1 arrival count between 11:00 and 12:00 (non-zero) and the arrival times match `stop_times.txt` for 3 sampled trips.

---

## 3. Scene choreography

Camera values are starting points. S5 and S6 tune them against screenshots. Sim-clock speed is a display rate, not a number on screen.

**Runtime budget: the presentation video is exactly 45 s.** Scene 1 runs 18 s and scene 2 runs 27 s, including a 1 s title card at the start and a 1 s end card. The keyframe tables below were drafted for about 60 s; S5 and S6 scale every keyframe time by 0.75 and keep the order and content. In the video, the scene 2 mitigation gate resolves automatically through `window.__scene.apply()`, so the rerun wait does not count against the budget (the recorder steps scene time, not wall time). S7 asserts the final MP4 duration is 45.0 s ± 0.1 s with `ffprobe`.

### Scene 1 · "Lorenzkirche 05:30 → 11:30" (18 s in the video, `SUNNY_SAT`, candidate `lorenzkirche`)

| Key | Scene time | Camera (lng, lat, zoom, pitch, bearing) | Sim clock | Layers on | Caption / bound values |
|---|---|---|---|---|---|
| K0 | 0.0 s | 11.0780, 49.4525, 13.8, 0, 0 | paused | terrain + texture | "The market has to move. Where?" |
| K1 | 0–6 s | fly to 11.0777, 49.4507, 17.0, 60, −30 (`FlyToInterpolator`, 6000 ms) | paused at 05:30 | + buildings fade 0 → 1 over 2 s, candidate outline | "St. Lorenzkirche · 05:30" (clock label from sim time) |
| K2 | 6–12 s | slow dolly toward the bottleneck position (zoom 17.8) | 05:30 → 06:15 | + vendor trips, bollard markers, bottleneck pulse at `bySlice['05:30_DELIVERY'].bottlenecks[type=BOLLARD_BLOCKAGE].{lng,lat}` | `"Markus: {personas.vendor.score}"`, chip `{personas.vendor.topFriction}`, bottleneck `{cause}` and `{time}` |
| K3 | 12–15 s | orbit bearing −30 → +20, target the subway entrances | jump to 11:15 | vendor trips off; commuter trips on; GTFS arrival ticks from `arrivals.json` | "11:30 · U1 arrivals" |
| K4 | 15–22 s | hold, slight push-in | 11:15 → 11:45 | + `HeatmapLayer` of `bySlice['11:30_PEAK'].heat` | `"Commuters: {personas.commuter.score}"`, `"Served {personas.commuter.served}"` |
| K5 | 22–25 s | pull back to zoom 16.5, pitch 50 | paused | all persona chips | 4 persona scores plus MarketScore from `score(result.criteria, weights)` |

### Scene 2 · "Kaufhof, rainy Saturday" (27 s in the video, `RAINY_SAT`, candidate `kaufhof`)

| Key | Scene time | Camera | Sim clock | Layers on | Caption / bound values |
|---|---|---|---|---|---|
| K0 | 0–5 s | fly from the scene-1 end view to 11.0800, 49.4490, 17.5, 55, 15 | paused | terrain, buildings, rain overlay (visual only), sheltered edges highlighted from `graph.json` | "Kaufhof · rainy Saturday" |
| K1 | 5–14 s | follow-cam on Helga's interpolated position (offset 60 m, pitch 60) | 10:00 → 10:20 | senior trips, steps edges red, elevator markers pulse when Helga passes | `"Oma Helga: {personas.senior.score}"`, `"Served {personas.senior.served} · dropped {personas.senior.droppedOut}"` |
| K2 | 14–19 s | cut to the rear loading point, zoom 18 | jump to 05:30 → 06:00 | vendor trips, loading marker | `"Markus: {personas.vendor.score}"`, `{personas.vendor.topFriction}` |
| K3 | 19–25 s | follow-cam on Lukas from the U-Bahn exit | 11:30 → 12:00 | commuter trips, Lukas highlighted, progress ring with no number | `"Lukas: {personas.commuter.score}"`, `{personas.commuter.topFriction}`, `"Dropped {personas.commuter.droppedOut}"` |
| K4 | 25 s (pause) | hold | paused | **Apply Claude mitigation** button | Live: the presenter clicks. Recording: the recorder clicks. The director calls `BriefClient.brief` (cached fallback), then `SimClient.run('kaufhof','RAINY_SAT', brief.losers.map(l=>l.mitigation), seed)`. A spinner shows "engine re-simulating". |
| K5 | after rerun, about 8 s | pull back to zoom 17 | replay 11:30 → 12:00 on the new result | kiosk markers, new commuter trips | Before/after chips: `{before.personas.commuter.score} → {after.personas.commuter.score}`, consensus before/after from the cockpit's consensus function, `seed {seed}` |

Live and recorded runs use the same seed. The HUD always shows `seed`, scenario and a "fixture" chip when `data=fixtures`.

---

## 4. Files to create

| Path | Owner | Task |
|---|---|---|
| `prep/scene3d/lod2_buildings.py`, `prep/scene3d/check_buildings.py` | A | P1 |
| `prep/scene3d/terrain.py`, `prep/scene3d/check_terrain.py` | A | P2 |
| `prep/scene3d/check_scene_graph.py` | A | P3 |
| `prep/scene3d/check_arrivals.py` | A | P4 |
| `public/data/buildings3d.json`, `public/data/terrain/*` | A (generated) | P1, P2 |
| `src/ui/scenes/types.ts` (`SceneDef`, `Keyframe`, `CaptionBinding`) | C | S2 |
| `src/ui/scenes/director.ts`, `src/ui/scenes/bind.ts`, `src/ui/scenes/heroes.ts` + `*.test.ts` | C | S2 |
| `src/ui/scenes/layers3d.ts` (terrain, buildings, draped sim layers) | C | S1 |
| `src/ui/scenes/SceneView.tsx` | C | S1 + S2 |
| `src/ui/scenes/SceneHUD.tsx`, `src/ui/scenes/PersonaChip.tsx` | C | S3 |
| `src/ui/scenes/scene1.ts`, `src/ui/scenes/scene2.ts` | C | S5, S6 |
| `src/ui/scenes/mitigation.ts` (Apply → brief → rerun) | C | S6 |
| `e2e/scene1.spec.ts`, `e2e/scene2.spec.ts`, `e2e/scene-rulezero.spec.ts`, `e2e/scene-perf.spec.ts` | C | S1–S9 |
| `src/sim/scene.test.ts` | B | S4 |
| `video/record.ts`, `video/captions.srt`, `video/credits.png` | A | S7 |
| One line in `src/main.tsx` for `?scene=` | Mahesh | by hand |

---

## 5. Task tree with acceptance criteria

Rule-zero checks used by several gates:

- **RZ-static (Vitest, `src/ui/scenes/rulezero.test.ts`):** caption templates in `scene1.ts` and `scene2.ts` contain no digit outside `{…}` bindings, except clock labels generated from sim time. `grep -nE '"[^"{]*[0-9]+ ?%' src/ui/scenes` prints nothing.
- **RZ-live (Playwright, `e2e/scene-rulezero.spec.ts`):** every element with `data-bind` renders text equal to `format(get(window.__scene.state.result, binding))`. The test seeks to each keyframe and checks all bound elements. After the mitigation rerun it checks against the new result.

| ID | Wave | Subtask | Depends on | Acceptance (orchestrator runs it) |
|---|---|---|---|---|
| **P1** | W1 (pre-event) | LoD2 → `buildings3d.json` | C0 | §2 P1 criteria; `uv run … check_buildings.py` exits 0. |
| **P2** | W1 | Terrain + texture | C0 | §2 P2 criteria; `uv run … check_terrain.py` exits 0. |
| **P3** | W1 | Scene graph checks | A's `graph.json` | `uv run … check_scene_graph.py` exits 0 and prints the blocking bollard node ID. |
| **P4** | W1 | GTFS arrival check | A's `arrivals.json` | `uv run … check_arrivals.py` exits 0 with a non-zero U1 count. |
| **S0** | W1 | Architecture spec: `src/ui/scenes/types.ts`, binding grammar, director API, hero rules, Q1–Q4 proposal text for the freeze | C0 | `npx tsc --noEmit` passes; Mahesh approves the API in under 10 minutes of reading. |
| **S1** | W2 (13:30–15:00) | `layers3d.ts` + `SceneView.tsx` shell: `TerrainLayer` with texture, buildings `PolygonLayer` (extruded, `getElevation = h`, 3D rings at `zBase`), draped `TripsLayer`/`ScatterplotLayer` via `TerrainExtension`, `?scene=1` renders | P1, P2, S0 | `npm run build`; `PORT=5181 npm run e2e -- scene1.spec.ts` (canvas, no console errors, screenshot `e2e/__shots__/scene-k1.png`); `scene-perf.spec.ts` headed: median fps ≥ 50 over 10 s with 100 trails and all buildings. |
| **S2** | W2 | Director: timeline, keyframe interpolation (`FlyToInterpolator` and linear), sim clock, `window.__scene` API, `bind.ts`, `heroes.ts`, follow-cam | S0 | Vitest: `seek(t)` is deterministic (same view state twice), bindings resolve nested paths, unresolved bindings render `—` and log an error, hero rules pick the expected trip on fixtures; RZ-static passes. |
| **S3** | W2 | HUD: persona chips (persona colours), friction chip, clock label, seed/scenario/fixture chips, caption fade, Apply button slot | S0 | Playwright: chips render from fixture values; RZ-live passes on fixtures; text ≥ 18 px at 1920 × 1080. |
| **S4** | W2 (B's branch) | Engine scene properties: Lorenzkirche `05:30_DELIVERY` emits a `BOLLARD_BLOCKAGE` at an OSM bollard; Kaufhof `RAINY_SAT` senior trips pass an elevator node and no steps edge; commuter dropouts appear at Kaufhof; a kiosk mitigation raises commuter score | B's engine at gate 15:00 | `npm test -- --run src/sim/scene.test.ts`: properties hold for seeds 1, 42, 7; same seed gives byte-identical JSON; one run < 1.5 s. The test asserts properties and orderings, never fixed values. |
| ⛳ **Gate 15:00** | | `?scene=1&data=fixtures` plays end to end with terrain, buildings and bound chips | S1–S3 | Mahesh watches one full play-through. |
| **S5** | W3 (15:00–16:30) | Scene 1 keyframes, layer toggles and captions per §3 | S1–S3 | `scene1.spec.ts` seeks K0–K5, saves 6 screenshots, RZ-live passes; full scene duration 22–28 s. |
| **S6** | W3 | Scene 2 keyframes plus `mitigation.ts`: pause, Apply, brief (cached fallback), rerun through `SimClient`, before/after replay | S1–S3, S4 or fixtures | `scene2.spec.ts`: Apply calls `SimClient.run` once with `brief.losers` mitigations, the HUD switches to the new result, RZ-live passes before and after; with the network blocked the cached brief path still completes. |
| **S7** | W3 | Recorder: `video/record.ts` opens `?scene=1` then `?scene=2` at 1920 × 1080, calls `window.__scene.step(33.33)` per frame, captures PNG frames, auto-clicks Apply, encodes with `ffmpeg -framerate 30 -c:v libx264 -pix_fmt yuv420p -crf 18`, appends a credits card (§3 attributions) | S2 (API only) | `npx tsx video/record.ts --data=fixtures` writes `video/out/urbantwin.mp4`; `ffprobe` reports 1920 × 1080, 30 fps, duration 50–70 s. |
| **S8** | W3 | Visual review of S5/S6 screenshots and the take-1 video | S5, S6, S7 | Reviewer lists misalignments, occlusions and unreadable captions with keyframe IDs; Mahesh steers S5/S6 on real findings. |
| **S9** | W4 (17:00–18:00) | Integration with the real worker and `/api/brief`; replace fixtures; recalibrate camera targets to the engine's actual bottleneck and hero trips | S5, S6, S4, C10 | `scene1.spec.ts`, `scene2.spec.ts`, `scene-rulezero.spec.ts` pass with `?data=worker` 3 runs in a row; `?data=fixtures` still passes. |
| **S10** | W5 (18:00–18:30) | Final video on the frozen build and seed | S9, code freeze | MP4 checked by `ffprobe`; Opus frame review finds no blocker; every bound number in 5 sampled frames matches the logged `SimulationResult` (the recorder writes `video/out/results.json`). |

---

## 6. Agent assignment

| ID | Harness | Model | Effort | Why this model |
|---|---|---|---|---|
| P1 | ruddr → codex | `gpt-6.1-sol` | xhigh | Streaming XML over 525 MB, geometry extraction and datum handling. Codex is strongest at long, test-driven Python and geometry work. |
| P2 | ruddr → codex | `gpt-6.1-sol` | high | Raster resampling and projection math with a numeric acceptance check. |
| P3 | ruddr → codex | `gpt-6.1-sol` | medium | Short graph-query script against a fixed schema. |
| P4 | ruddr → codex | `gpt-6.1-sol` | medium | Small GTFS filter; cheap and well bounded. |
| S0 | ruddr → claude | `claude-opus-5-5` | high | Defines the binding contract and director API that every other scene task builds on. Architecture errors here cost the most. |
| S1 | ruddr → codex | `gpt-6.1-sol` | high | deck.gl terrain, 3D polygons and `TerrainExtension`, with an fps target. Heavy TypeScript rendering work. |
| S2 | ruddr → claude | `claude-opus-5-5` | high | Timeline semantics, determinism and rule-zero bindings need careful design more than volume. |
| S3 | ruddr → codex | `gpt-6.1-sol` | medium | React HUD components that render given values. |
| S4 | ruddr → codex | `gpt-6.1-sol` | xhigh | Engine-level property tests across seeds inside B's Dijkstra and tick loop. Runs only with B's agreement on B's branch. |
| S5 | ruddr → codex | `gpt-6.1-sol` | high | Keyframe tuning from screenshots is iterative glue work with visual feedback. |
| S6 | ruddr → codex | `gpt-6.1-sol` | high | Async rerun inside a running timeline, with fallbacks and state swaps. More logic than layout. |
| S7 | ruddr → codex | `gpt-6.1-sol` | medium | Playwright plus ffmpeg script with a crisp `ffprobe` check. |
| S8 | `codex exec -s read-only -i` | `gpt-6.1-sol` | high | Fresh read-only session with image input; runs on ChatGPT-plan quota. |
| S9 | interactive Claude Code with Mahesh | `claude-opus-5-5` | high | Cross-role debugging (A data, B worker, D brief) needs a human in the loop. |
| S10 | Mahesh runs S7's script; review by `claude -p` | `claude-opus-5-5` | high | Final frame check before the pitch. A Claude reviewer keeps the other-vendor rule, since Codex wrote S1 and S6. |
| Reviews of Codex branches (P1, P2, S1, S3, S4, S5, S6, S7) | claude -p `--permission-mode plan` | `claude-opus-5-5` | medium | Other-vendor, read-only review. Opus is the only Claude model left in the build, so it keeps the cross-vendor check. |
| Reviews of Claude branches (S0, S2) | `git diff c/ui... | codex exec -s read-only` | `gpt-6.1-sol` (config default) | medium | Other-vendor review focused on rule zero and determinism. |

---

## 7. Waves, worktrees and dispatch

### 7.1 Wave structure

| Wave | Window | Parallel tasks | Gate before the next wave |
|---|---|---|---|
| W0 | pre-event | C0 scaffold (from the role C plan) with `@deck.gl/extensions` added | C0 done-check passes. |
| W1 | pre-event | P1 ∥ P2 ∥ S0, then P3 ∥ P4 when A's `graph.json` and `arrivals.json` exist | P1/P2 checks pass; S0 approved. |
| W2 | 13:30–15:00 | S1 ∥ S2 ∥ S3 (C worktrees), S4 (B's branch, from 14:30 if B's engine runs one site) | Gate 15:00: scene 1 plays on fixtures. |
| W3 | 15:00–16:30 | S5 ∥ S6 ∥ S7, then S8 | Both scenes pass their specs on fixtures; take-1 video exists. |
| W4 | 17:00–18:00 | S9 (interactive) | Gate 18:00: both scenes pass 3 times in a row on real data. |
| W5 | 18:00–18:30 | S10 | Final MP4 copied to the demo laptop and a USB stick. |

Scene work must not delay role C's Must items (C4–C8). If C4–C8 are behind at 15:00, S5 and S6 shrink to scene 1 only, and scene 2 runs live in the normal cockpit with the Apply button.

### 7.2 Setup (once, pre-event)

```bash
R="/run/media/maheshk/New Volume/MK-solutions/claude_imapct_lab"
grep -qx '.scratch/' "$R/.git/info/exclude" || echo ".scratch/" >> "$R/.git/info/exclude"
ruddr models --json | grep -c '"gpt-6.1-sol"'    # expect 1
mkdir -p "$R/.scratch/scenes"/{p1,p2,p3,p4,s0,s1,s2,s3,s4,s5,s6,s7,s8,s10}
# brief.md per task = role C shared preamble (C plan §5.1) + task block below + Ruddr handoff block verbatim
```

Worktrees follow the role C convention: `git -C "$R" worktree add "$R/../ut-<id>" -b <branch> <base>`, then `npm ci` in each worktree from the orchestrator before launch (Codex `workspace-write` blocks network). Each Playwright run uses its own port: S1 5181, S2 5182, S3 5183, S5 5185, S6 5186, S7 5187.

| ID | Worktree · branch | Base | May write |
|---|---|---|---|
| P1 | `../ut-p1` · `a/p1-lod2` | `main` | `prep/scene3d/lod2_buildings.py`, `check_buildings.py`, `public/data/buildings3d.json` |
| P2 | `../ut-p2` · `a/p2-terrain` | `main` | `prep/scene3d/terrain.py`, `check_terrain.py`, `public/data/terrain/` |
| P3 | `../ut-p3` · `a/p3-graphcheck` | A's graph branch | `prep/scene3d/check_scene_graph.py` |
| P4 | `../ut-p4` · `a/p4-arrivals` | A's arrivals branch | `prep/scene3d/check_arrivals.py` |
| S0 | `../ut-s0` · `c/s0-scene-spec` | `c/ui` | `src/ui/scenes/types.ts` |
| S1 | `../ut-s1` · `c/s1-scene-layers` | `c/ui` + S0 | `src/ui/scenes/layers3d.ts`, `SceneView.tsx`, `e2e/scene1.spec.ts`, `e2e/scene-perf.spec.ts` |
| S2 | `../ut-s2` · `c/s2-director` | `c/ui` + S0 | `src/ui/scenes/director.ts`, `bind.ts`, `heroes.ts`, `*.test.ts`, `rulezero.test.ts` |
| S3 | `../ut-s3` · `c/s3-hud` | `c/ui` + S0 | `src/ui/scenes/SceneHUD.tsx`, `PersonaChip.tsx`, `e2e/scene-rulezero.spec.ts` |
| S4 | `../ut-s4` · `b/s4-scene-props` | B's branch | `src/sim/scene.test.ts`, engine fixes B approves |
| S5 | `../ut-s5` · `c/s5-scene1` | `c/ui` + S1–S3 | `src/ui/scenes/scene1.ts`, `e2e/scene1.spec.ts` |
| S6 | `../ut-s6` · `c/s6-scene2` | `c/ui` + S1–S3 | `src/ui/scenes/scene2.ts`, `mitigation.ts`, `e2e/scene2.spec.ts` |
| S7 | `../ut-s7` · `a/s7-recorder` | `c/ui` + S2 | `video/` |

### 7.3 Dispatch commands

Codex tasks (always `--model gpt-6.1-sol`; Ruddr's Codex default is the excluded `gpt-6-astra`):

```bash
R="/run/media/maheshk/New Volume/MK-solutions/claude_imapct_lab"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort xhigh --sandbox workspace-write \
  --cwd "$R/../ut-p1" --turn-timeout 75m \
  --prompt-file "$R/.scratch/scenes/p1/brief.md" --state-dir "$R/.scratch/scenes/p1/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort high --sandbox workspace-write \
  --cwd "$R/../ut-p2" --turn-timeout 60m \
  --prompt-file "$R/.scratch/scenes/p2/brief.md" --state-dir "$R/.scratch/scenes/p2/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort medium --sandbox workspace-write \
  --cwd "$R/../ut-p3" --turn-timeout 30m \
  --prompt-file "$R/.scratch/scenes/p3/brief.md" --state-dir "$R/.scratch/scenes/p3/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort high --sandbox workspace-write \
  --cwd "$R/../ut-s1" --turn-timeout 75m \
  --prompt-file "$R/.scratch/scenes/s1/brief.md" --state-dir "$R/.scratch/scenes/s1/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort xhigh --sandbox workspace-write \
  --cwd "$R/../ut-s4" --turn-timeout 60m \
  --prompt-file "$R/.scratch/scenes/s4/brief.md" --state-dir "$R/.scratch/scenes/s4/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort high --sandbox workspace-write \
  --cwd "$R/../ut-s6" --turn-timeout 75m \
  --prompt-file "$R/.scratch/scenes/s6/brief.md" --state-dir "$R/.scratch/scenes/s6/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort medium --sandbox workspace-write \
  --cwd "$R/../ut-s3" --turn-timeout 60m \
  --prompt-file "$R/.scratch/scenes/s3/brief.md" --state-dir "$R/.scratch/scenes/s3/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort medium --sandbox workspace-write \
  --cwd "$R/../ut-p4" --turn-timeout 30m \
  --prompt-file "$R/.scratch/scenes/p4/brief.md" --state-dir "$R/.scratch/scenes/p4/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort high --sandbox workspace-write \
  --cwd "$R/../ut-s5" --turn-timeout 75m \
  --prompt-file "$R/.scratch/scenes/s5/brief.md" --state-dir "$R/.scratch/scenes/s5/run"
ruddr run --detach --provider codex --model gpt-6.1-sol --effort medium --sandbox workspace-write \
  --cwd "$R/../ut-s7" --turn-timeout 60m \
  --prompt-file "$R/.scratch/scenes/s7/brief.md" --state-dir "$R/.scratch/scenes/s7/run"
```

Claude tasks:

```bash
ruddr run --detach --provider claude --model claude-opus-5-5 --effort high --sandbox workspace-write \
  --cwd "$R/../ut-s0" --turn-timeout 40m \
  --prompt-file "$R/.scratch/scenes/s0/brief.md" --state-dir "$R/.scratch/scenes/s0/run"
ruddr run --detach --provider claude --model claude-opus-5-5 --effort high --sandbox workspace-write \
  --cwd "$R/../ut-s2" --turn-timeout 75m \
  --prompt-file "$R/.scratch/scenes/s2/brief.md" --state-dir "$R/.scratch/scenes/s2/run"
```

Fallback if Ruddr rejects `--effort` for a Claude model (example S2):

```bash
cd "$R/../ut-s2" && claude -p --model claude-opus-5-5 --effort high --permission-mode acceptEdits \
  --max-budget-usd 15 --output-format json < "$R/.scratch/scenes/s2/brief.md" > "$R/.scratch/scenes/s2/out.json"
```

Read-only reviews and the visual check:

```bash
# Codex-written branch reviewed by Claude Opus (example S1)
cd "$R/../ut-s1" && git diff c/ui... | claude -p --model claude-opus-5-5 --effort medium \
  --permission-mode plan --max-budget-usd 2 "$(cat "$R/.scratch/scenes/review.md")"
# Claude-written branch reviewed by Codex (example S2; commit first)
cd "$R/../ut-s2" && git diff c/ui... | codex exec -m gpt-6.1-sol -s read-only "$(cat "$R/.scratch/scenes/review.md")"  # codex review rejects a prompt with --base
# Shared visual-review prompt for S8 and S10
VR="Report per image: building/terrain misalignment, trails hidden under terrain or buildings, unreadable captions at \
projector distance, and any on-screen number that has no data-bind source in video/out/results.json. Do not edit files."
# S8: GPT, read-only, keyframe screenshots plus take-1 frames
ffmpeg -i "$R/video/out/urbantwin.mp4" -vf fps=1/5 "$R/.scratch/scenes/s8/frame_%02d.png"
cd "$R" && codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only \
  -i "$R"/.scratch/scenes/s8/frame_*.png "$R"/e2e/__shots__/scene-*.png -- "$VR"
# S10: Opus, read-only, frames from the final video
ffmpeg -i "$R/video/out/urbantwin.mp4" -vf fps=1/5 "$R/.scratch/scenes/s10/frame_%02d.png"
cd "$R" && claude -p --model claude-opus-5-5 --effort high --permission-mode plan --max-budget-usd 5 \
  "Read every PNG in .scratch/scenes/s10/. $VR"
```

`review.md` extends the role C cross-review prompt with three checks: numeric literals in captions, wall-clock use instead of `window.__scene` time, and any `Math.random` in scene code.

### 7.4 Task blocks (append to the role C shared preamble)

- **P1 (Codex):** "Write `prep/scene3d/lod2_buildings.py` per `docs/3D_SCENES_ORCHESTRATION_PLAN.md` §2 P1. Stream with `lxml.etree.iterparse`, never load a whole tile. Read `baseElevation` from `public/data/terrain/terrain.json` if present, else compute it from `datasets/dgm1`. Write `check_buildings.py` with the §2 P1 acceptance asserts and run both."
- **P2 (Codex):** "Write `prep/scene3d/terrain.py` per §2 P2. Use inverse mapping from the WGS84 target grid to UTM; do not warp with an axis-aligned bbox. Write `check_terrain.py` with the §2 P2 asserts (it reads LoD2 ground z through `lod2_buildings.py` helpers or a 200-building sample) and run it."
- **S0 (Opus):** "Design `src/ui/scenes/types.ts`: `SceneDef`, `Keyframe`, `LayerToggle`, `CaptionBinding`, `HeroRule`, and the `window.__scene` API from §1. Add doc comments on determinism (no wall clock, no `Math.random`) and the binding grammar. Draft the Q1–Q4 freeze text as a comment block. No runtime code beyond types."
- **S1 (Codex):** "Build `layers3d.ts` and `SceneView.tsx` per §1 decision 1 and §5 S1. Standalone `DeckGL`, no MapLibre. Keep static layers memoized; only trips and the bottleneck pulse update per frame."
- **S2 (Opus):** "Build the director, binding resolver and hero rules per §1 decisions 2–4 and §5 S2. Expose `window.__scene`. Seek must be pure: `seek(t)` from any state gives the same view state."
- **S3 (Codex):** "Build the HUD per §5 S3. Every number element carries `data-bind` with its path. Write `scene-rulezero.spec.ts` per the RZ-live definition."
- **S4 (Codex, B's branch):** "Write `src/sim/scene.test.ts` asserting the §5 S4 properties for seeds 1, 42, 7. Fix the engine only where a property fails because of a bug, and list every engine change in the handoff report for B."
- **S5 (Codex):** "Write `scene1.ts` per §3 Scene 1. Tune keyframes with screenshots from `scene1.spec.ts` until the bottleneck, the station entrances and the church are all visible at their keyframes."
- **S6 (Codex):** "Write `scene2.ts` and `mitigation.ts` per §3 Scene 2 and §5 S6. Apply must work with the fixture adapters, the worker adapter and a blocked network."
- **S7 (Codex):** "Write `video/record.ts` per §5 S7 and §9. Also write `video/out/results.json` with every `SimulationResult` and `Brief` the run used."

### 7.5 Monitor, verify, merge

Monitoring, scope checks, failure policy and merge mechanics follow `docs/C_ROLE_ORCHESTRATION_PLAN.md` §6.3–§6.5 with `--root "$R/.scratch/scenes"`. Merge order into `c/ui`: S0 → S2 → S3 → S1 → S5 → S6; A merges P1, P2 and S7 into A's branch; B merges S4. After each merge: `npm ci && npm run build && npm test -- --run && npm run e2e -- scene`.

---

## 8. Risks and blockers

| ID | Risk or blocker | Mitigation |
|---|---|---|
| B1 | Kaufhof footprint and rear loading point are not tagged in OSM. | A confirms them from LoD2 and DOP20 before 13:00 and commits `public/data/landmarks.json` (`kaufhof.polygon`, `kaufhof.loadingNode`). S6 reads only that file. |
| B2 | The Kaufhof interior has no walkable graph. Without synthetic edges Helga's elevator route cannot exist. | P3 asserts a step-free elevator route exists. If it fails at 13:00, A adds interior edges by hand from the footprint. |
| B3 | Contract questions Q1–Q4 are unresolved. | Settle them at the 13:20 freeze. Every fallback in §1 keeps the scenes running without the additive fields. |
| R1 | `TerrainExtension` costs fps with 100 trails and about 10,000 buildings. | S1 measures fps headed. Fallbacks in order: drop buildings below 6 m, lower the terrain mesh `meshMaxError` to 4 m, switch to flat terrain at `baseElevation` (the Altstadt relief is small away from the Burgberg). |
| R2 | Buildings float or sink relative to the terrain. | Both use DHHN2016 with one `baseElevation`. P2 asserts the median offset below 0.5 m. |
| R3 | The engine does not produce a bollard blockage at Lorenzkirche, or Kaufhof commuters do not drop out. | The scene shows what the engine produces. S4 detects it early; if the data says otherwise, the pitch text changes, not the numbers. |
| R4 | The live rerun takes too long on stage. | The worker run must stay under 1.5 s (B's done-check). The brief call falls back to the cached brief after 6 s. The recording proves the loop if the live run fails. |
| R5 | Recording stutters on the laptop. | The recorder steps the director clock per frame, so render speed does not affect the video. |
| R6 | Ruddr picks `gpt-6-astra` when `--model` is missing. | Every Codex command in §7.3 passes `--model gpt-6.1-sol`. The scope check greps `ruddr status --json` for the model ID. |
| R7 | Scene work starves role C's Must items. | §7.1 cut rule at 15:00: scene 1 only. |

---

## 9. Recorded video fallback

- **Takes.** Take 1 at 17:30 on whatever data is merged (fixture chip visible if fixtures). Final take between 18:00 and 18:30 on the frozen build with `?data=worker` and the pitch seed.
- **Method.** Playwright Chromium at 1920 × 1080, device scale 1, frame-stepped capture through `window.__scene.step`, `ffmpeg` H.264 at 30 fps, CRF 18. Scene 1 and scene 2 concatenate with a 0.5 s crossfade; a 3 s credits card ends the video.
- **Burn-in.** Seed, scenario and "engine output" in the HUD corner on every frame. Captions come from the bound HUD, not from an SRT, so the video carries the same numbers the engine produced. `video/captions.srt` holds only the narrative lines without numbers for accessibility.
- **Provenance.** `video/out/results.json` stores the exact results and brief the run used. S10 checks 5 sampled frames against it.
- **Storage.** `video/out/` stays out of Git (`.gitignore`). Copies go to the demo laptop desktop and a USB stick. A holds the fallback during the pitch.

---

## 10. Timing against the 7-hour schedule

| Time | Scene work | Agents running | Human |
|---|---|---|---|
| Pre-event | W0 C0; W1 P1, P2, S0, then P3, P4 | Codex ×4, Opus ×1 | Mahesh approves S0; A confirms B1 |
| 13:00–13:30 | Freeze Q1–Q4 with B and D | none | All |
| 13:30–15:00 | W2 S1, S2, S3; S4 from 14:30 | Codex ×3, Opus ×1 | Mahesh adds the `?scene=` line, reviews |
| ⛳ 15:00 | Scene 1 plays on fixtures | | Mahesh |
| 15:00–16:30 | W3 S5, S6, S7, then S8 | Codex ×4 | Mahesh merges, steers on S8 findings |
| 16:30–17:00 | Dinner; take-1 prep | none | |
| 17:00–18:00 | W4 S9 with real worker and brief; take 1 at 17:30 | Opus interactive | Mahesh + D |
| ⛳ 18:00 | Code freeze; both scenes pass 3 times | | |
| 18:00–18:30 | W5 S10 final video and Opus frame check | Opus ×1 | A records, Mahesh checks |
| 18:30–20:00 | Live scenes during the pitch; video as fallback | none | C drives, A holds video |

### Budget

| Task | Cap |
|---|---|
| Codex runs (P1–P4, S1, S3–S8, reviews) | ChatGPT-plan quota; turn timeouts in §7.3 |
| S0 Opus | $6 |
| S2 Opus | $15 |
| S9 Opus interactive | $15 |
| S8 GPT | ChatGPT-plan quota |
| S10 Opus | $5 |
| Opus cross-reviews of 8 Codex branches | $2 each |
| **Scene total, Claude** | **≈ $57 ceiling** |
