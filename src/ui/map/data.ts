import { useEffect, useState } from 'react';

export type LngLat = [number, number];
export interface OrthoTile { url: string; bounds: [LngLat, LngLat, LngLat, LngLat] } // BL, TL, TR, BR
export interface Building { polygon: LngLat[]; holes?: LngLat[][]; h: number }

/** Fetch JSON; resolves null on a non-JSON or non-OK response (Vite serves index.html for unknown paths). */
async function getJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
  return r.json() as Promise<T>;
}

/** Load once; the returned reference stays stable so layers memoized on it never rebuild. */
function useJson<T>(load: () => Promise<T | null>): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) setData(d); }).catch((e) => console.warn('[map] load failed', e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return data;
}

export const useOrthoTiles = () => useJson(() => getJson<OrthoTile[]>('/base/dop20.json'));
export const useBollards = () => useJson(() => getJson<LngLat[]>('/base/bollards.json'));
/** LoD2 buildings from the prep pipeline; OSM footprints when /data/buildings.json is absent. */
export const useBuildings = () =>
  useJson(async () => {
    // Part A writes { source, fields, buildings }; the C1 fallback is a bare array.
    const lod2 = await getJson<Building[] | { buildings: Building[] }>('/data/buildings.json');
    if (lod2) return Array.isArray(lod2) ? lod2 : lod2.buildings;
    return getJson<Building[]>('/base/buildings-osm.json');
  });
