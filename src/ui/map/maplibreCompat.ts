import type { Map as MaplibreMap } from 'maplibre-gl';

/**
 * @deck.gl/mapbox 9.4 reads `map.transform` (near/far planes, height, elevation) in interleaved mode.
 * MapLibre 6 moved it to `map._camera.transform`; re-expose it so deck can build its viewport.
 */
export function exposeTransform(map: MaplibreMap) {
  const m = map as unknown as { transform?: unknown; _camera?: { transform: unknown } };
  if (m.transform === undefined && m._camera) {
    Object.defineProperty(map, 'transform', { configurable: true, get: () => m._camera!.transform });
  }
}
