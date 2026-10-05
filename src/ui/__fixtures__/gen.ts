import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Candidate, Brief, SimulationResult, Scenario, TimeSlice, PersonaId, Bottleneck } from '../../contracts';

// Seeded RNG for deterministic fixtures
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LngLat = [number, number];
type Path = LngLat & { tSec?: number };

// Load footways or parse from altstadt.json
function loadFootways(): LngLat[][] {
  const basePath = join(import.meta.dirname, '../../../public/base/footways.json');
  const altPath = join(import.meta.dirname, '../../../datasets/osm/altstadt.json');

  try {
    const data = JSON.parse(readFileSync(basePath, 'utf-8'));
    if (Array.isArray(data) && data.length > 0) return data;
  } catch {
    // Fall back to altstadt
  }

  const alt = JSON.parse(readFileSync(altPath, 'utf-8'));
  const footways: LngLat[][] = [];
  for (const elem of alt.elements) {
    if (elem.type === 'way' && elem.geometry && elem.geometry.length > 1) {
      footways.push(elem.geometry.map((p: any) => [p.lon, p.lat]));
    }
  }
  return footways;
}

function distance(a: LngLat, b: LngLat): number {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Find footway segment near a point
function findNearbyFootwaySegment(rng: ReturnType<typeof mulberry32>, point: LngLat, footways: LngLat[][]): LngLat[] {
  const candidates: LngLat[][] = [];
  for (const way of footways) {
    for (let i = 0; i < way.length - 1; i++) {
      if (distance(way[i], point) < 0.003) {
        candidates.push([way[i], way[i + 1]]);
      }
    }
  }
  return candidates.length > 0 ? candidates[Math.floor(rng() * candidates.length)] : [point, [point[0] + 0.0001, point[1] + 0.0001]];
}

// Generate a trip path following footway geometry
function generateTripPath(rng: ReturnType<typeof mulberry32>, startPoint: LngLat, footways: LngLat[][], duration: number, speed: number = 0.0001): LngLat[] {
  const path: LngLat[] = [startPoint];
  let current = startPoint;
  let t = 0;
  const maxTime = 3600;

  while (t < maxTime && path.length < 50) {
    const segment = findNearbyFootwaySegment(rng, current, footways);
    const segmentDist = distance(segment[0], segment[1]);
    const steps = Math.max(1, Math.floor(segmentDist / (speed * 5)));

    for (let i = 1; i <= steps && t < maxTime; i++) {
      const alpha = i / steps;
      const next: LngLat = [
        segment[0][0] + (segment[1][0] - segment[0][0]) * alpha,
        segment[0][1] + (segment[1][1] - segment[0][1]) * alpha,
      ];
      path.push(next);
      t = Math.min(t + 30, maxTime); // 30-second steps, capped at 3600
    }
    current = segment[1];
  }

  return path;
}

// Generate bottlenecks
function generateBottlenecks(rng: ReturnType<typeof mulberry32>, loc: LngLat, count: number): Bottleneck[] {
  const types: Bottleneck['type'][] = ['BOLLARD_BLOCKAGE', 'COBBLESTONE_FRICTION', 'ELEVATOR_CONGESTION', 'CROWDING'];
  const bottlenecks: Bottleneck[] = [];

  for (let i = 0; i < count; i++) {
    bottlenecks.push({
      lat: loc[1] + (rng() - 0.5) * 0.001,
      lng: loc[0] + (rng() - 0.5) * 0.001,
      severity: rng() * 0.7 + 0.3,
      type: types[Math.floor(rng() * types.length)],
      time: `${String(5 + Math.floor(rng() * 10)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}`,
      cause: ['blocked by cars', 'steep cobblestones', 'elevator out of service', 'peak hour crush'][Math.floor(rng() * 4)],
    });
  }

  return bottlenecks;
}

// Generate heat points (visitor concentration)
function generateHeatPoints(rng: ReturnType<typeof mulberry32>, loc: LngLat, density: number): [number, number, number][] {
  const points: [number, number, number][] = [];
  const count = Math.floor(20 + density * 30);

  for (let i = 0; i < count; i++) {
    points.push([
      loc[0] + (rng() - 0.5) * 0.002,
      loc[1] + (rng() - 0.5) * 0.002,
      Math.floor(rng() * 255),
    ]);
  }

  return points;
}

function generateCandidates(rng: ReturnType<typeof mulberry32>): Candidate[] {
  const benchmarks: Candidate[] = [
    {
      id: 'HAUPTMARKT',
      name: 'Hauptmarkt',
      kind: 'benchmark',
      polygon: [[11.07744, 49.45393], [11.07764, 49.45393], [11.07764, 49.45373], [11.07744, 49.45373]],
      areaM2: 4500,
      indicators: {
        transitScore: 92,
        walkScore: 95,
        population800m: 18500,
        retailPoi400m: 42,
        attractions400m: 15,
        deliveryAccess: true,
        vanDistM: 45,
      },
      passedFilter: true,
    },
    {
      id: 'LORENZKIRCHE',
      name: 'Lorenzkirche',
      kind: 'benchmark',
      polygon: [[11.07773, 49.45095], [11.07793, 49.45095], [11.07793, 49.45075], [11.07773, 49.45075]],
      areaM2: 3200,
      indicators: {
        transitScore: 98,
        walkScore: 93,
        population800m: 16200,
        retailPoi400m: 38,
        attractions400m: 12,
        deliveryAccess: false, // Intentionally marked as false per spec
        vanDistM: 320,
      },
      passedFilter: true,
    },
    {
      id: 'KAUFHOF',
      name: 'ehem. Kaufhof',
      kind: 'benchmark',
      polygon: [[11.0800, 49.4490], [11.0820, 49.4490], [11.0820, 49.4470], [11.0800, 49.4470]],
      areaM2: 4800,
      indicators: {
        transitScore: 87,
        walkScore: 89,
        population800m: 15800,
        retailPoi400m: 35,
        attractions400m: 10,
        deliveryAccess: true,
        vanDistM: 60,
      },
      passedFilter: true,
    },
  ];

  const squares = [
    { id: 'HALLERWIESE', name: 'Hallerwiese', loc: [11.0698, 49.4556] },
    { id: 'TUCHER_SCHLOSS_PLATZ', name: 'Tucher-Schloss-Platz', loc: [11.0745, 49.4588] },
    { id: 'KORNMARKT', name: 'Kornmarkt', loc: [11.0822, 49.4518] },
    { id: 'LUDWIGS_PLATZ', name: 'Ludwigs-Platz', loc: [11.0761, 49.4465] },
    { id: 'RATHHAUS_PLATZ', name: 'Rathaus-Platz', loc: [11.0782, 49.4536] },
    { id: 'MAXTORPLATZ', name: 'Maxtorplatz', loc: [11.0683, 49.4478] },
    { id: 'NASSAUER_PLATZ', name: 'Nassauer Platz', loc: [11.0918, 49.4531] },
    { id: 'WEISSER_TURM', name: 'Weißer Turm', loc: [11.0710, 49.4425] },
    { id: 'UNSCHLITT_PLATZ', name: 'Unschlitt-Platz', loc: [11.0821, 49.4460] },
    { id: 'ADLERPLATZ', name: 'Adlerplatz', loc: [11.0911, 49.4565] },
    { id: 'BURGSTRASSE', name: 'Burgstraße', loc: [11.0755, 49.4410] },
    { id: 'KAISERBURG_HOF', name: 'Kaiserburg-Hof', loc: [11.0739, 49.4385] },
    { id: 'FRANGASSE', name: 'Frangasse', loc: [11.0645, 49.4510] },
    { id: 'PLARRERPLATZ', name: 'Plarrer-Platz', loc: [11.0632, 49.4550] },
    { id: 'FRAUENPLATZ', name: 'Frauenplatz', loc: [11.0853, 49.4545] },
  ];

  const candidates: Candidate[] = [...benchmarks];

  // Deterministically select exactly 3 non-benchmark candidates to pass the filter
  const passingNonBenchmark = new Set<number>();
  passingNonBenchmark.add(2);  // KORNMARKT (index 2)
  passingNonBenchmark.add(3);  // LUDWIGS_PLATZ (index 3)
  passingNonBenchmark.add(4);  // RATHHAUS_PLATZ (index 4)

  // Reject reasons to distribute: "area < 800 m²", "no stop within 400 m", "no van route within 80 m"
  const rejectReasons = [
    'area < 800 m²',
    'no stop within 400 m',
    'no van route within 80 m',
  ];
  let rejectReasonIndex = 0;

  for (let i = 0; i < squares.length; i++) {
    const sq = squares[i];
    const area = 1200 + rng() * 2800;
    const transitScore = 65 + rng() * 30;
    const passedFilter = passingNonBenchmark.has(i);

    const candidate: Candidate = {
      id: sq.id,
      name: sq.name,
      kind: 'pedestrian',
      polygon: [
        sq.loc as LngLat,
        [sq.loc[0] + 0.0005, sq.loc[1]],
        [sq.loc[0] + 0.0005, sq.loc[1] - 0.0005],
        [sq.loc[0], sq.loc[1] - 0.0005],
      ],
      areaM2: Math.round(area),
      indicators: {
        transitScore: Math.round(transitScore),
        walkScore: Math.round(70 + rng() * 25),
        population800m: Math.round(12000 + rng() * 8000),
        retailPoi400m: Math.round(20 + rng() * 30),
        attractions400m: Math.round(5 + rng() * 15),
        deliveryAccess: passedFilter || rng() < 0.4,
        vanDistM: Math.round(50 + rng() * 250),
      },
      passedFilter,
    };

    if (!passedFilter) {
      candidate.rejectReason = rejectReasons[rejectReasonIndex % rejectReasons.length];
      rejectReasonIndex++;
    }

    candidates.push(candidate);
  }

  return candidates;
}

function generateSimulationResult(
  candidateId: string,
  scenario: Scenario,
  seed: number,
  candidate: Candidate,
  footways: LngLat[][],
): SimulationResult {
  const rng = mulberry32(seed);
  const isRainy = scenario === 'RAINY_SAT';

  // Generate trips
  const trips: SimulationResult['trips'] = [];
  const personas: PersonaId[] = ['senior', 'vendor', 'commuter', 'retailer'];
  const tripCount = 100 + Math.floor(rng() * 50);

  for (let i = 0; i < tripCount; i++) {
    const persona = personas[Math.floor(rng() * personas.length)];
    const startTime = Math.floor(rng() * 1200); // 0-1200 to allow 30-sec steps up to 3600
    const duration = 800 + Math.floor(rng() * 1000); // max ~1800 seconds
    const path = generateTripPath(rng, candidate.polygon[0], footways, duration).map((p, idx) => {
      const tSec = Math.min(startTime + idx * 30, 3600);
      return [p[0], p[1], tSec] as [number, number, number];
    });

    trips.push({ persona, path });
  }

  // Persona scores - at least one below 40
  const baseScores: Record<PersonaId, number> = {
    senior: 50 + rng() * 45,
    vendor: 45 + rng() * 50,
    commuter: 40 + rng() * 55,
    retailer: 55 + rng() * 40,
  };

  // Force at least one score below 40 for some candidates
  if (rng() < 0.3) {
    const lowPersona = personas[Math.floor(rng() * personas.length)];
    baseScores[lowPersona] = 15 + rng() * 20;
  }

  const personas_result: Record<PersonaId, any> = {
    senior: { score: 0, served: 0, droppedOut: 0, topFriction: '' },
    vendor: { score: 0, served: 0, droppedOut: 0, topFriction: '' },
    commuter: { score: 0, served: 0, droppedOut: 0, topFriction: '' },
    retailer: { score: 0, served: 0, droppedOut: 0, topFriction: '' },
  };
  for (const p of personas) {
    let score = baseScores[p];
    if (isRainy) score = Math.max(5, score - (10 + rng() * 15)); // Rain reduces scores
    personas_result[p] = {
      score: Math.round(score),
      served: Math.round(80 + rng() * 20),
      droppedOut: Math.round(rng() * 20),
      topFriction: ['wet surfaces', 'steps without elevator', 'tight delivery window', 'crowded paths'][
        Math.floor(rng() * 4)
      ],
    };
  }

  return {
    candidateId,
    scenario,
    seed,
    mitigations: [],
    criteria: {
      accessibility: Math.round(60 + rng() * 35),
      footfall: Math.round(55 + rng() * 40),
      fairness: Math.round(45 + rng() * 50),
      localBusiness: Math.round(50 + rng() * 45),
      walkability: Math.round(55 + rng() * 40),
    },
    personas: personas_result,
    bySlice: {
      '05:30_DELIVERY': {
        heat: generateHeatPoints(rng, candidate.polygon[0], 0.4),
        bottlenecks: generateBottlenecks(rng, candidate.polygon[0], Math.floor(1 + rng() * 2)),
      },
      '11:30_PEAK': {
        heat: generateHeatPoints(rng, candidate.polygon[0], 0.9),
        bottlenecks: generateBottlenecks(rng, candidate.polygon[0], Math.floor(2 + rng() * 2)),
      },
      '15:00_LULL': {
        heat: generateHeatPoints(rng, candidate.polygon[0], 0.5),
        bottlenecks: generateBottlenecks(rng, candidate.polygon[0], Math.floor(1 + rng() * 2)),
      },
    },
    stallExposure: Array.from({ length: 20 }, () => Math.floor(rng() * 200 + 50)),
    trips,
  };
}

async function main() {
  const rng = mulberry32(42);
  const footways = loadFootways();
  const candidates = generateCandidates(rng);
  const passingCandidates = candidates.filter((c) => c.passedFilter);

  // Write candidates
  const fixturesDir = join(import.meta.dirname, '../../../public/data/fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(
    join(fixturesDir, 'candidates.json'),
    JSON.stringify(candidates, null, 2),
  );

  // Delete old result files for candidates that didn't pass
  const { readdirSync, unlinkSync } = await import('fs');
  try {
    const files = readdirSync(fixturesDir);
    const passingIds = new Set(passingCandidates.map((c) => c.id));
    for (const file of files) {
      if (file.startsWith('result-') && file.endsWith('.json')) {
        const candidateId = file.replace(/^result-/, '').replace(/-SUNNY_SAT\.json$|^-RAINY_SAT\.json$/, '').replace(/-SUNNY_SAT\.json$|^-RAINY_SAT\.json$/, '');
        const parts = file.match(/^result-(.+)-(SUNNY_SAT|RAINY_SAT)\.json$/);
        if (parts) {
          const id = parts[1];
          if (!passingIds.has(id)) {
            unlinkSync(join(fixturesDir, file));
          }
        }
      }
    }
  } catch {
    // Ignore if directory doesn't exist yet
  }

  // Write results for each passing candidate x scenario
  const scenarios: Scenario[] = ['SUNNY_SAT', 'RAINY_SAT'];
  for (const candidate of passingCandidates) {
    for (const scenario of scenarios) {
      const result = generateSimulationResult(candidate.id, scenario, 42, candidate, footways);
      writeFileSync(
        join(fixturesDir, `result-${candidate.id}-${scenario}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  }

  // Write brief
  const brief: Brief = {
    recommended: 'KAUFHOF',
    why: [
      'Excellent accessibility for seniors with elevators and level floors (95%)',
      'Reliable delivery access with rear loading (92% vendor satisfaction)',
      'Strong footfall from proximate retail areas',
    ],
    comparisons: [
      {
        site: 'Lorenzkirche',
        betterAt: 'commuter access from U-Bahn station',
        worseAt: 'vendor delivery (bollards block vans at 05:30)',
      },
      {
        site: 'Hauptmarkt',
        betterAt: 'iconic location, highest foot traffic',
        worseAt: 'conflicts with existing events (conflicts with recurring programs)',
      },
    ],
    losers: [
      {
        persona: 'commuter',
        mitigation: 'add shuttle service from station during peak hours',
      },
    ],
    councilBriefMd: '# Market Relocation Brief\n\nKaufhof offers the best balance across all stakeholder groups.',
  };

  writeFileSync(
    join(fixturesDir, 'brief.json'),
    JSON.stringify(brief, null, 2),
  );

  console.log(`✓ Generated ${candidates.length} candidates (${passingCandidates.length} passing)`);
  console.log(`✓ Generated ${passingCandidates.length * scenarios.length} simulation results`);
  console.log(`✓ Generated brief`);
}

main().catch(console.error);
