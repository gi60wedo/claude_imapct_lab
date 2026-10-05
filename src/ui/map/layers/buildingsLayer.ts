import { SolidPolygonLayer } from '@deck.gl/layers';
import type { Building } from '../data';

export const buildingsLayer = (data: Building[]) =>
  new SolidPolygonLayer<Building>({
    id: 'buildings',
    data,
    extruded: true,
    getPolygon: (d) => (d.holes?.length ? [d.polygon, ...d.holes] : d.polygon),
    getElevation: (d) => d.h,
    getFillColor: [203, 213, 225, 235],
    material: { ambient: 0.45, diffuse: 0.6, shininess: 16, specularColor: [60, 64, 70] },
  });
