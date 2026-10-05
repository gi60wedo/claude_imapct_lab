import { ScatterplotLayer } from '@deck.gl/layers';
import type { LngLat } from '../data';

export const bollardsLayer = (data: LngLat[]) =>
  new ScatterplotLayer<LngLat>({
    id: 'bollards',
    data,
    getPosition: (d) => d,
    getRadius: 1.2,
    radiusMinPixels: 2.5,
    getFillColor: [249, 115, 22, 230],
    stroked: true,
    getLineColor: [15, 23, 42, 255],
    lineWidthMinPixels: 1,
  });
