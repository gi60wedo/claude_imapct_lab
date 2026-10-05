import { describe, it, expect } from 'vitest';
import type { Candidate, Brief, SimulationResult, Bottleneck, PersonaId } from '../../contracts';

// Import fixture JSON files
import candidatesData from '../../../public/data/fixtures/candidates.json';
import briefData from '../../../public/data/fixtures/brief.json';
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
  describe('Candidates', () => {
    it('should have 18 candidates', () => {
      expect(candidates).toHaveLength(18);
    });

    it('should have exactly 6 passing candidates', () => {
      const passing = candidates.filter((c) => c.passedFilter);
      expect(passing).toHaveLength(6);
    });

    it('should have exactly 12 rejected candidates with rejectReason', () => {
      const rejected = candidates.filter((c) => !c.passedFilter);
      expect(rejected).toHaveLength(12);
      rejected.forEach((c) => {
        expect(c.rejectReason).toBeDefined();
        expect(['area < 800 m²', 'no stop within 400 m', 'no van route within 80 m']).toContain(c.rejectReason);
      });
    });

    it('should use all 3 reject reasons at least twice', () => {
      const rejected = candidates.filter((c) => !c.passedFilter);
      const reasons = rejected.map((c) => c.rejectReason);
      const reasonCounts: Record<string, number> = {};
      reasons.forEach((r) => {
        reasonCounts[r!] = (reasonCounts[r!] || 0) + 1;
      });
      expect(Object.keys(reasonCounts)).toHaveLength(3);
      Object.values(reasonCounts).forEach((count) => {
        expect(count).toBeGreaterThanOrEqual(2);
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
