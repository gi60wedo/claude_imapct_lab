// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProjection, distanceToPolygon } from '../geo';

const fixture = vi.hoisted(() => ({ osm: '', rejectSpokes: false }));
vi.mock('../geo', async (importOriginal) => {
  const geo = await importOriginal<typeof import('../geo')>();
  return { ...geo, segmentWithinPolygon: (...args: Parameters<typeof geo.segmentWithinPolygon>) =>
    !fixture.rejectSpokes && geo.segmentWithinPolygon(...args) };
});
afterEach(() => { fixture.rejectSpokes = false; });
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: () => false,   // no prep graph.json: slope comes from the fixture's tags
  readFileSync: (file: string) => {
    if (file.endsWith('altstadt.json')) return fixture.osm;
    if (file.endsWith('stations.dev.json')) return '[]';
    if (file.endsWith('.csv')) return 'id,x,y,value\n';
    throw new Error(`Unexpected input ${file}`);
  },
}));
import { buildOsmWorld } from '../dev/osmWorld';

describe('walkable OSM areas', () => {
  it('keeps the perimeter without creating an orphan when every spoke is rejected', () => {
    fixture.rejectSpokes = true;
    const proj = new LocalProjection(11.07, 49.45);
    const ring: [number, number][] = [[0, 0], [120, 0], [120, 30], [30, 30], [30, 120], [0, 120]];
    fixture.osm = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: [1, 2, 3, 4, 5, 6, 1],
      geometry: [...ring, ring[0]].map(([x, y]) => {
        const [lon, lat] = proj.toLngLat(x, y);
        return { lon, lat };
      }), tags: { highway: 'pedestrian', area: 'yes' } }] });
    const { graph } = buildOsmWorld();
    const connected = new Set(graph.edges.flatMap((e) => [e.a, e.b]));
    expect(graph.nodes.every((_, i) => connected.has(i))).toBe(true);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges).toHaveLength(6);
  });
  it('keeps every generated connection inside a concave L-shaped polygon', () => {
    const proj = new LocalProjection(11.07, 49.45);
    const ring: [number, number][] = [[0, 0], [120, 0], [120, 30], [30, 30], [30, 120], [0, 120]];
    const coordinates = [...ring, ring[0]].map(([x, y]) => {
      const [lon, lat] = proj.toLngLat(x, y);
      return { lon, lat };
    });
    fixture.osm = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: [1, 2, 3, 4, 5, 6, 1],
      geometry: coordinates, tags: { highway: 'pedestrian', area: 'yes' } }] });
    const { graph } = buildOsmWorld();
    expect(graph.nodes[0].lng).toBeCloseTo(11.07, 8);
    expect(graph.edges.length).toBeGreaterThan(6); // Preserve useful crossings as well as the perimeter.
    for (const e of graph.edges) {
      const a = proj.toXY(graph.nodes[e.a].lng, graph.nodes[e.a].lat);
      const b = proj.toXY(graph.nodes[e.b].lng, graph.nodes[e.b].lat);
      for (let k = 0; k <= 100; k++) {
        const t = k / 100;
        expect(distanceToPolygon(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), ring)).toBeLessThan(1e-6);
      }
    }
  });
});
