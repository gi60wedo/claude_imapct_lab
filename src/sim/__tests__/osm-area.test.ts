// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LocalProjection, distanceToPolygon } from '../geo';

const fixture = vi.hoisted(() => ({ osm: '' }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: (file: string) => {
    if (file.endsWith('altstadt.json')) return fixture.osm;
    if (file.endsWith('stations.dev.json')) return '[]';
    if (file.endsWith('.csv')) return 'id,x,y,value\n';
    throw new Error(`Unexpected input ${file}`);
  },
}));
import { buildOsmWorld } from '../dev/osmWorld';

describe('walkable OSM areas', () => {
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
