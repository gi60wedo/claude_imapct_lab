# prep/ — Part A: Geodata, Discovery & Ranking

Converts `datasets/` into the small JSON files in `public/data/` that the browser uses. Types for every file are in
`src/contracts.ts`.

```bash
git lfs pull          # LoD2 CityGML (~525 MB) is stored in Git LFS
npm install
npm run prep          # full rebuild from raw data (~45 s), then applies src/rank
npm run rank:bake     # re-apply filter + ranking only (after changing thresholds or weights)
npm test              # vitest: src/rank unit tests + checks on the real candidates.json
```

Python dependencies come from `prep/pyproject.toml` through `uv`. Nothing is installed globally.
Individual steps: `cd prep && uv run python graph.py` (or `lod2`, `population`, `transit`, `imagery`, `candidates`).
`uv run python render.py <candidate-id>…` writes aerial-photo QA images to `prep/cache/render/`.

## Outputs (`public/data/`)

| File | Content | Consumer |
|---|---|---|
| `candidates.json` | 36 sites (33 discovered + 3 benchmarks): polygon, area, indicators, filter verdict with reason, quick rank, and `evidence` (van route, blocker, stops, walk metrics, `siteNode`) | C map/ranking, B sim, D brief |
| `mock-candidates.json` | the same candidates as a plain `Candidate[]` (the 13:20 fixture name) | everyone |
| `graph.json` | 11,786 nodes / 12,900 edges walk+drive graph (steps, bollards, cobbles, shelter, slope, `vehicleAllowed`, `vanRestrictions`) | B (Dijkstra) |
| `population.json` | 1,847 Zensus 100 m cells (pop, share 65+, average age) around the Altstadt | B (resident origins) |
| `arrivals.json` | 72 stations with every Saturday arrival time per mode (GTFS) | B (commuter waves) |
| `buildings.json` | 9,680 LoD2 footprints with height and ground elevation | C (3D extrusion) |
| `imagery.json` + `imagery/` | DOP20 aerial photo (0.5 m/px) and ALKIS parcel tiles with BitmapLayer corner bounds | C (base map) |

## Method (all numbers computed, no hand-entered values)

**Discovery.** Candidates come from OSM `place=square` ways, `highway=pedestrian` + `area=yes` polygons, and
vacant buildings (`disused:*` / `shop=vacant`, ≥ 300 m²). Duplicates are merged, and the three organiser
benchmarks from `sites.json` replace anything discovered at the same place.
- **Former Kaufhof:** OSM way 144721687 (Königstraße 42–52, `old_name=Galeria Kaufhof`), centroid 49.44982, 11.07835.
  The coordinate in the plan (49.4490, 11.0800) points at small apartment buildings.
- **Lorenzkirche plaza:** OSM has no polygon for it, only pedestrian lines named Lorenzer Platz. The outline is
  those lines buffered by 9 m and kept within 40 m of the church.

**Van rules (3.5 t Sprinter, Saturday 2026-10-10, 05:30).**
- Pedestrian ways are closed unless their tags allow the van.
- `access` → `vehicle` → `motor_vehicle` tags and their `:conditional` variants are evaluated at 05:30. For
  example, `delivery @ (05:00-20:00)` opens a way and `destination @ (22:00-05:00)` does not.
- `destination` and `delivery` count as allowed.
- Every bollard type (removable, fixed, foldable, rising) blocks, unless its `maxwidth:physical` is at least 2.2 m.
- Gates, chains and blocks also stop the van. So do `maxheight` < 2.8 m, `maxwidth` < 2.2 m and `maxweight` < 3.5 t.
- Oneways are respected.

A site has delivery access if a legal route enters from an arterial road at the edge of the study area, reaches a
stop within an 80 m trolley push of the site, and can leave again. The trolley push is measured on the walk network,
or as a straight line if no building is in the way. If the site has no access, `blockedBy` names the first rule a
van would break on the cheapest physical route.

**Indicators.**
- **Transit:** Saturday departures within a 300 m walk to the nearest platform, log-scaled.
- **Walkability:** cobble share, mean grade and step share on the walk network within 300 m.
- **Population:** Zensus residents within 800 m.
- **Points of interest:** OSM shops and attractions within 400 m.
- **Slope:** DGM1 smoothed over 9 m, measured over a baseline of at least 10 m along each edge. 104 wall and façade
  artefacts above 25 % are capped and flagged `slopeSuspect`.

**Filter and rank** (`src/rank`, TypeScript, pure). A site is rejected, with every reason listed, if:
- its area is below 800 m²,
- it has no stop within a 400 m walk, or
- its van stop is more than 80 m away.

The quick score is 0.30 transit + 0.20 population + 0.20 retail + 0.10 attractions + 0.10 walk + 0.10 area
(area saturates at 3,000 m²). Counts are min–max normalised over the passing sites. The shortlist is the top 3
discovered sites plus all benchmarks.

## Findings the team should know

- **Lorenzkirche passes the delivery filter.** A legal van route (Marientor → Lorenzer Straße) reaches a stop
  58 m from the east end of the plaza, but it is **150 m from the plaza centre** (`evidence.vanToCentreM`). The
  vendor penalty therefore has to come from B's van→stall distance, not from the filter. Kaufhof's van stop is 48 m
  away at the Königstraße corner, via `motor_vehicle=destination` segments.
- 29 of 36 sites pass. Most Altstadt plazas touch a street that is legal for `destination` traffic at 05:30, so
  the filter rejects 7 sites, not "most of them": 6 are too small (Burghof also has no van access), and
  Willy-Prölß-Platz has no road within 80 m.
- Shortlist: Kornmarkt, City Point (vacant mall, 5,688 m²) and Hallplatz (directly behind the Kaufhof), plus
  Hauptmarkt, Lorenzkirche and Kaufhof.

## Known limitations

- 98 of the 221 OSM bollards are not on any way, so they cannot block a route.
- Roads tagged `foot=use_sidepath` are not walkable, because their sidewalks are mapped as separate ways.
- The Hauptmarkt outline is OSM's `place=square`, which includes the strip to the Museumsbrücke (8,209 m²).
- Ground-floor area is the LoD2 roof footprint, not a surveyed usable floor area.
- Removable bollards are treated as closed. A permit for market vendors is a possible mitigation that is not modelled.
