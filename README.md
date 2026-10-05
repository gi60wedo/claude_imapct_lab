# 🏛️ UrbanTwin: Market-Sim

**Track 2 · Fraunhofer IIS Challenge** · Claude Impact Lab #2, Nürnberg

Nuremberg's vegetable market has to leave the **Hauptmarkt**. UrbanTwin is a digital twin of the Altstadt that simulates a market Saturday at each candidate site. The organizer sites are Hauptmarkt, St. Lorenzkirche and the former Kaufhof. The twin shows who wins and who loses: seniors, vendors, commuters and nearby shops. Claude explains the trade-offs and proposes fixes, and the engine re-simulates them.

> **Rule zero:** every number comes from the engine and real Nuremberg data. Claude explains results but never invents a number.

For a one-page visual explainer of what the project does, who it's for and how it works, open [`docs/PROJECT_OVERVIEW.html`](docs/PROJECT_OVERVIEW.html) in a browser. The full plan is in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md). A printable version is in [`docs/UrbanTwin_Group_Plan.pdf`](docs/UrbanTwin_Group_Plan.pdf).

---

## Status

| Part | Owner | Status |
|---|---|---|
| `datasets/`: raw open data | A | ✅ in repo |
| `src/contracts.ts`: shared types (§5) | all | ✅ |
| `src/sim/`: pedestrian & delivery twin | B | ✅ runs on real data with DGM1 slope and the LoD2 Kaufhof footprint |
| `prep/`, `src/rank/`: discovery & ranking | A | ✅ |
| `src/ui/`: map, ranking, cockpit | C | ✅ |
| `src/score/`, `server/brief.ts`: scoring & Claude | D | ✅ |

---

## Quick start

Requires Node 22.18+ and `unzip` on the PATH, which is only needed to re-extract GTFS.

```bash
npm install
npm test               # Vitest: synthetic grid + Nuremberg integration
npm run sim:report     # 3 benchmark sites × 3 scenarios, printed as a table
npm run typecheck
```

Example output of `npm run sim:report` (sunny Saturday, seed 42):

```
                     Hauptmarkt   Lorenzkirche   Kaufhof
👵 Senior               100          100          70.4
🚚 Vendor               92.6          5.0         61.0
💼 Commuter             71.4         91.0         73.8
🛍️ Retailer             59.2         54.1         64.2
```

---

## How the twin works (`src/sim/`)

1. **Load data.** Street and footpath graph from OSM, residents and 65+ share from Zensus 2022, Saturday U-Bahn arrivals from VGN GTFS.
2. **Create agents.** 👵 seniors and residents, 💼 lunch commuters, tourists, passers-by, and 🚚 vendor vans from 05:30.
3. **Route.** Dijkstra with costs per persona: cobblestones ×2.5 and steps blocked for seniors, rain ×1.3 on open streets, vans only on vehicle-legal roads and stopped by bollards.
4. **Decide.** Agents drop out when the site is beyond their walking or time budget.
5. **Tick.** The day runs in 30-second steps, producing the footfall heatmap, crowding, elevator load and bollard blockages.
6. **Score.** 5 criteria (accessibility, footfall, fairness, local business, walkability) and 4 persona scores, each with its top friction.

**What-if scenarios:** `SUNNY_SAT`, `RAINY_SAT` and `CHRISTMAS_MARKET`, which blocks the Hauptmarkt and doubles tourists.

**Mitigations Claude can propose:** an express kiosk, a delivery window, a loading point, or a loop stall layout.

A fixed seed gives an identical result, and one site × scenario runs in under 0.25 s. Every model assumption is in [`src/sim/params.ts`](src/sim/params.ts). Integration notes for A, C and D are in [`src/sim/README.md`](src/sim/README.md).

```ts
import { createTwin } from './src/sim';
const twin = createTwin(world);
const result = twin.run(candidate, { scenario: 'RAINY_SAT', seed: 42 });
```

---

## Repository layout

```
claude_imapct_lab/
├─ IMPLEMENTATION_PLAN.md   master plan (team roles, scoring, sprint, pitch)
├─ datasets/                OSM, LoD2, DGM1, DOP20, ALKIS, Zensus, GTFS (see datasets/README.md)
├─ docs/                    printable plan
├─ src/
│  ├─ contracts.ts          shared types, frozen at 13:20
│  └─ sim/                  B: twin engine, worker, tests, dev data builder
├─ optional_plan.md         early workflow draft
└─ workflow_overview.md     one-page workflow summary
```

## Known open points

- **Lorenzkirche delivery:** the engine finds the nearest vehicle-legal road 94 m from the stalls (limit 80 m), so vendors score 5. OSM also shows a van route via Adlerstraße. Check those tags on site before the pitch.
- **Kaufhof seniors:** the nearest step-free stop or elevator is about 390 m from the LoD2 footprint. The store's own elevators aren't in OSM, so this may understate senior access.

---

## Data credits

- Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0
- © OpenStreetMap contributors, ODbL
- Statistisches Bundesamt (Destatis), Zensus 2022, dl-de/by-2-0
- VGN Verkehrsverbund Großraum Nürnberg, open data
