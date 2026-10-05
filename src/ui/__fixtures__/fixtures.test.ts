import { describe, it, expect } from 'vitest';
import type { Candidate, Brief, SimulationResult, Bottleneck, PersonaId } from '../../contracts';
import { buildFootwayGraph, generateTripPath, mulberry32 } from './gen';

// Import fixture JSON files
import candidatesData from '../../../public/data/fixtures/candidates.json';
import briefData from '../../../public/data/fixtures/brief.json';
import footways from '../../../public/base/footways.json';
import resultHAUPTMARKT_SUNNY from '../../../public/data/fixtures/result-HAUPTMARKT-SUNNY_SAT.json';
import resultHAUPTMARKT_RAINY from '../../../public/data/fixtures/result-HAUPTMARKT-RAINY_SAT.json';
import resultLORENZKIRCHE_SUNNY from '../../../public/data/fixtures/result-LORENZKIRCHE-SUNNY_SAT.json';
import resultLORENZKIRCHE_RAINY from '../../../public/data/fixtures/result-LORENZKIRCHE-RAINY_SAT.json';
import resultKAUFHOF_SUNNY from '../../../public/data/fixtures/result-KAUFHOF-SUNNY_SAT.json';
import resultKAUFHOF_RAINY from '../../../public/data/fixtures/result-KAUFHOF-RAINY_SAT.json';
import resultKORNMARKT_SUNNY from '../../../public/data/fixtures/result-KORNMARKT-SUNNY_SAT.json';
import resultKORNMARKT_RAINY from '../../../public/data/fixtures/result-KORNMARKT-RAINY_SAT.json';
import resultLUDWIGS_PLATZ_SUNNY from '../../../public/data/fixtures/result-LUDWIGS_PLATZ-SUNNY_SAT.json';
import resultLUDWIGS_PLATZ_RAINY from '../../../public/data/fixtures/result-LUDWIGS_PLATZ-RAINY_SAT.json';
import resultRATHHAUS_PLATZ_SUNNY from '../../../public/data/fixtures/result-RATHHAUS_PLATZ-SUNNY_SAT.json';
import resultRATHHAUS_PLATZ_RAINY from '../../../public/data/fixtures/result-RATHHAUS_PLATZ-RAINY_SAT.json';

const candidates = candidatesData as unknown as Candidate[];
const brief = briefData as unknown as Brief;

function distanceM(a: number[], b: number[]): number {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const results: SimulationResult[] = [
  resultHAUPTMARKT_SUNNY,
  resultHAUPTMARKT_RAINY,
  resultLORENZKIRCHE_SUNNY,
  resultLORENZKIRCHE_RAINY,
  resultKAUFHOF_SUNNY,
  resultKAUFHOF_RAINY,
  resultKORNMARKT_SUNNY,
  resultKORNMARKT_RAINY,
  resultLUDWIGS_PLATZ_SUNNY,
  resultLUDWIGS_PLATZ_RAINY,
  resultRATHHAUS_PLATZ_SUNNY,
  resultRATHHAUS_PLATZ_RAINY,
] as unknown as SimulationResult[];

describe('Fixtures', () => {
  describe('Trip generator', () => {
    it('should join endpoints within 2 metres and stay on connected edges', () => {
      const graph = buildFootwayGraph([
        [[11, 49], [11.001, 49]],
        [[11.001, 49.00001], [11.001, 49.001]],
        // This nearby edge belongs to a separate component.
        [[11, 49.0001], [11.0008, 49.0001]],
      ]);
      expect(graph).toHaveLength(5);
      expect(graph[1].neighbors).toEqual([0, 2]);
      const path = generateTripPath(mulberry32(42), [11, 49.00001], graph, 240);
      expect(path[0]).toEqual([11, 49]);
      expect(path).toHaveLength(9);
      expect(path).toContainEqual([11.001, 49]);
      expect(path.some((point) => point[1] > 49.0001)).toBe(true);
      path.forEach((point, i) => {
        expect(Math.abs(point[1] - 49) < 1e-10 || Math.abs(point[0] - 11.001) < 1e-10).toBe(true);
        if (i > 0) expect(distanceM(path[i - 1], point)).toBeLessThanOrEqual(60);
      });
    });

    it('should keep endpoints more than 2 metres apart disconnected', () => {
      const graph = buildFootwayGraph([
        [[11, 49], [11.001, 49]],
        [[11.001, 49.00003], [11.001, 49.001]],
      ]);
      expect(graph).toHaveLength(4);
      expect(graph[1].neighbors).toEqual([0]);
      expect(graph[2].neighbors).toEqual([3]);
    });

    it('should produce identical random walks with seed 42', () => {
      const graph = buildFootwayGraph(footways as [number, number][][]);
      const start = candidates[0].polygon[0];
      const generate = () => {
        const rng = mulberry32(42);
        return Array.from({ length: 10 }, () => generateTripPath(rng, start, graph, 1200));
      };
      expect(generate()).toEqual(generate());
    });
  });

  describe('Candidates', () => {
    it('should have 18 candidates', () => {
      expect(candidates).toHaveLength(18);
    });

    it('should have exactly 6 passing candidates', () => {
      const passing = candidates.filter((c) => c.passedFilter);
      expect(passing).toHaveLength(6);
      expect(passing.map((c) => c.id)).toEqual([
        'HAUPTMARKT', 'LORENZKIRCHE', 'KAUFHOF', 'KORNMARKT', 'LUDWIGS_PLATZ', 'RATHHAUS_PLATZ',
      ]);
    });

    it('should preserve all candidate ids', () => {
      expect(candidates.map((c) => c.id)).toEqual([
        'HAUPTMARKT', 'LORENZKIRCHE', 'KAUFHOF', 'HALLERWIESE', 'TUCHER_SCHLOSS_PLATZ',
        'KORNMARKT', 'LUDWIGS_PLATZ', 'RATHHAUS_PLATZ', 'MAXTORPLATZ', 'NASSAUER_PLATZ',
        'WEISSER_TURM', 'UNSCHLITT_PLATZ', 'ADLERPLATZ', 'BURGSTRASSE', 'KAISERBURG_HOF',
        'FRANGASSE', 'PLARRERPLATZ', 'FRAUENPLATZ',
      ]);
    });

    it('should have exactly 12 rejected candidates with rejectReason', () => {
      const rejected = candidates.filter((c) => !c.passedFilter);
      expect(rejected).toHaveLength(12);
      rejected.forEach((c) => {
        expect(c.rejectReason).toBeDefined();
        expect(['area < 800 m²', 'no stop within 400 m', 'no van route within 80 m']).toContain(c.rejectReason);
      });
    });

    it('should preserve four rejections for each reason', () => {
      const rejected = candidates.filter((c) => !c.passedFilter);
      const reasons = rejected.map((c) => c.rejectReason);
      const reasonCounts: Record<string, number> = {};
      reasons.forEach((r) => {
        reasonCounts[r!] = (reasonCounts[r!] || 0) + 1;
      });
      expect(reasonCounts).toEqual({
        'area < 800 m²': 4,
        'no stop within 400 m': 4,
        'no van route within 80 m': 4,
      });
    });

    it('should have indicators consistent with each rejection reason', () => {
      candidates.filter((c) => !c.passedFilter).forEach((candidate) => {
        switch (candidate.rejectReason) {
          case 'area < 800 m²':
            expect(candidate.areaM2, candidate.id).toBeLessThan(800);
            break;
          case 'no stop within 400 m':
            expect(candidate.indicators.transitScore, candidate.id).toBeLessThan(40);
            break;
          case 'no van route within 80 m':
            expect(candidate.indicators.deliveryAccess, candidate.id).toBe(false);
            expect(candidate.indicators.vanDistM, candidate.id).toBeGreaterThan(80);
            break;
        }
      });
    });

    it('should have 3 benchmarks (all passing)', () => {
      const benchmarks = candidates.filter((c) => c.kind === 'benchmark');
      expect(benchmarks).toHaveLength(3);
      expect(benchmarks.map((c) => c.id)).toContain('HAUPTMARKT');
      expect(benchmarks.map((c) => c.id)).toContain('LORENZKIRCHE');
      expect(benchmarks.map((c) => c.id)).toContain('KAUFHOF');
      benchmarks.forEach((b) => {
        expect(b.passedFilter).toBe(true);
      });
    });

    it('should mark LORENZKIRCHE with deliveryAccess=false', () => {
      const lorenzkirche = candidates.find((c) => c.id === 'LORENZKIRCHE');
      expect(lorenzkirche).toBeDefined();
      expect(lorenzkirche!.indicators.deliveryAccess).toBe(false);
    });

    it('should have valid polygon coordinates', () => {
      candidates.forEach((c) => {
        expect(c.polygon).toBeDefined();
        expect(Array.isArray(c.polygon)).toBe(true);
        expect(c.polygon.length).toBeGreaterThan(0);
        c.polygon.forEach((coord) => {
          expect(coord).toHaveLength(2);
          const [lng, lat] = coord;
          expect(typeof lng).toBe('number');
          expect(typeof lat).toBe('number');
        });
      });
    });

    it('should use only real OSM names', () => {
      const realNames = new Set(['Hauptmarkt', 'Lorenzkirche', 'ehem. Kaufhof', 'Hallerwiese',
        'Tucher-Schloss-Platz', 'Kornmarkt', 'Ludwigs-Platz', 'Rathaus-Platz', 'Maxtorplatz',
        'Nassauer Platz', 'Weißer Turm', 'Unschlitt-Platz', 'Adlerplatz', 'Burgstraße',
        'Kaiserburg-Hof', 'Frangasse', 'Plarrer-Platz', 'Frauenplatz']);
      candidates.forEach((c) => {
        expect(realNames.has(c.name)).toBe(true);
      });
    });
  });

  describe('Simulation Results', () => {
    it('should have exactly 12 results (6 passing candidates x 2 scenarios)', () => {
      expect(results).toHaveLength(12);
    });

    it('should have results only for passing candidates', () => {
      const passingCandidates = candidates.filter((c) => c.passedFilter);
      const resultCandidateIds = new Set(results.map((r) => r.candidateId));
      const passingIds = new Set(passingCandidates.map((c) => c.id));
      expect(resultCandidateIds).toEqual(passingIds);
    });

    it('should have both SUNNY_SAT and RAINY_SAT results for each passing candidate', () => {
      const passingCandidates = candidates.filter((c) => c.passedFilter);
      passingCandidates.forEach((candidate) => {
        const sunnyResults = results.filter((r) => r.candidateId === candidate.id && r.scenario === 'SUNNY_SAT');
        const rainyResults = results.filter((r) => r.candidateId === candidate.id && r.scenario === 'RAINY_SAT');
        expect(sunnyResults).toHaveLength(1);
        expect(rainyResults).toHaveLength(1);
      });
    });

    it('should have >= 100 trips per result', () => {
      results.forEach((r) => {
        expect(r.trips.length).toBeGreaterThanOrEqual(100);
      });
    });

    it('should snap every trip start to a footway vertex', () => {
      const vertices = footways.flat();
      const starts = new Map<string, number[]>();
      results.forEach((result) => result.trips.forEach((trip) => {
        const start = trip.path[0];
        starts.set(`${start[0]},${start[1]}`, start);
      }));
      starts.forEach((start) => {
        expect(vertices.some((vertex) => distanceM(start, vertex) < 0.01)).toBe(true);
      });
    });

    it('should keep every consecutive trip point within 60 metres', () => {
      results.forEach((result) => result.trips.forEach((trip, tripIndex) => {
        expect(trip.path.length).toBeGreaterThan(1);
        for (let i = 1; i < trip.path.length; i++) {
          const label = `${result.candidateId}/${result.scenario} trip ${tripIndex}, step ${i}`;
          expect(distanceM(trip.path[i - 1], trip.path[i]), label).toBeLessThanOrEqual(60);
        }
      }));
    });

    it('should use seed 42 for every result', () => {
      results.forEach((result) => expect(result.seed).toBe(42));
    });

    it('should have trips with valid path format [lng, lat, tSec]', () => {
      // Sample check to avoid timeout on large datasets
      results.slice(0, 3).forEach((r) => {
        r.trips.slice(0, 10).forEach((trip) => {
          expect(trip.path).toBeDefined();
          expect(Array.isArray(trip.path)).toBe(true);
          trip.path.forEach((point) => {
            expect(point).toHaveLength(3);
            const [lng, lat, tSec] = point;
            expect(typeof lng).toBe('number');
            expect(typeof lat).toBe('number');
            expect(typeof tSec).toBe('number');
            expect(tSec).toBeGreaterThanOrEqual(0);
            expect(tSec).toBeLessThanOrEqual(3600);
          });
        });
      });
    }, 30000);

    it('should reference existing candidates', () => {
      const candidateIds = new Set(candidates.map((c) => c.id));
      results.forEach((r) => {
        expect(candidateIds.has(r.candidateId)).toBe(true);
      });
    });

    it('should have persona scores within 0-100', () => {
      results.forEach((r) => {
        Object.values(r.personas).forEach((persona) => {
          expect(persona.score).toBeGreaterThanOrEqual(0);
          expect(persona.score).toBeLessThanOrEqual(100);
        });
      });
    });

    it('should have all time slices', () => {
      results.forEach((r) => {
        expect(r.bySlice['05:30_DELIVERY']).toBeDefined();
        expect(r.bySlice['11:30_PEAK']).toBeDefined();
        expect(r.bySlice['15:00_LULL']).toBeDefined();
      });
    });

    it('should have bottlenecks for each time slice', () => {
      results.forEach((r) => {
        const slices: Array<'05:30_DELIVERY' | '11:30_PEAK' | '15:00_LULL'> = ['05:30_DELIVERY', '11:30_PEAK', '15:00_LULL'];
        slices.forEach((slice) => {
          const sliceData = r.bySlice[slice];
          expect(sliceData.bottlenecks).toBeDefined();
          expect(Array.isArray(sliceData.bottlenecks)).toBe(true);
          sliceData.bottlenecks.forEach((bn: Bottleneck) => {
            expect(bn.lat).toBeDefined();
            expect(bn.lng).toBeDefined();
            expect(bn.severity).toBeGreaterThanOrEqual(0);
            expect(bn.severity).toBeLessThanOrEqual(1);
            expect(bn.type).toMatch(/BOLLARD_BLOCKAGE|COBBLESTONE_FRICTION|ELEVATOR_CONGESTION|CROWDING/);
          });
        });
      });
    });

    it('should have heat points for each time slice', () => {
      results.forEach((r) => {
        const slices: Array<'05:30_DELIVERY' | '11:30_PEAK' | '15:00_LULL'> = ['05:30_DELIVERY', '11:30_PEAK', '15:00_LULL'];
        slices.forEach((slice) => {
          const sliceData = r.bySlice[slice];
          expect(sliceData.heat).toBeDefined();
          expect(Array.isArray(sliceData.heat)).toBe(true);
          sliceData.heat.forEach((point: [number, number, number]) => {
            expect(point).toHaveLength(3);
            const [lng, lat, intensity] = point;
            expect(typeof lng).toBe('number');
            expect(typeof lat).toBe('number');
            expect(typeof intensity).toBe('number');
            expect(intensity).toBeGreaterThanOrEqual(0);
            expect(intensity).toBeLessThanOrEqual(255);
          });
        });
      });
    });

    it('should have 20 stall exposure values', () => {
      results.forEach((r) => {
        expect(r.stallExposure).toHaveLength(20);
        r.stallExposure.forEach((val) => {
          expect(typeof val).toBe('number');
          expect(val).toBeGreaterThan(0);
        });
      });
    });

    it('should have different scores for SUNNY vs RAINY scenarios', () => {
      const sunnyResults = results.filter((r) => r.scenario === 'SUNNY_SAT');
      const rainyResults = results.filter((r) => r.scenario === 'RAINY_SAT');

      sunnyResults.forEach((sunny) => {
        const rainy = rainyResults.find((r) => r.candidateId === sunny.candidateId);
        expect(rainy).toBeDefined();
        // At least one persona should have different scores
        let hasDifference = false;
        const personas: PersonaId[] = ['senior', 'vendor', 'commuter', 'retailer'];
        personas.forEach((persona) => {
          if (sunny.personas[persona].score !== rainy!.personas[persona].score) {
            hasDifference = true;
          }
        });
        expect(hasDifference).toBe(true);
      });
    });

    it('should have no CHRISTMAS_MARKET results', () => {
      results.forEach((r) => {
        expect(r.scenario).not.toBe('CHRISTMAS_MARKET');
      });
    });
  });

  describe('Brief', () => {
    it('should have required fields', () => {
      expect(brief.recommended).toBeDefined();
      expect(brief.why).toBeDefined();
      expect(brief.comparisons).toBeDefined();
      expect(brief.losers).toBeDefined();
      expect(brief.councilBriefMd).toBeDefined();
    });

    it('should recommend an existing candidate', () => {
      const candidateIds = new Set(candidates.map((c) => c.id));
      expect(candidateIds.has(brief.recommended)).toBe(true);
    });
  });
});
