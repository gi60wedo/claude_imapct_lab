import { BitmapLayer } from '@deck.gl/layers';
import type { OrthoTile } from '../data';

/** DOP20 aerial tiles, each placed on its four projected corners. */
export const orthoLayers = (tiles: OrthoTile[]) =>
  tiles.map((t) => new BitmapLayer({ id: `dop20-${t.url}`, image: t.url, bounds: t.bounds }));
