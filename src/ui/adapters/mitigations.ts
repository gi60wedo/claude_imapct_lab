import type { Candidate } from '../../contracts';
import type { Mitigation } from '../../sim';

const centroid = (c: Candidate): [number, number] => {
  const pts = c.polygon;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
};

/**
 * Turn a brief's free-text mitigation into the engine's structured Mitigation.
 * A JSON string that already is a Mitigation passes through; otherwise keywords pick the kind.
 * Returns null when the text maps to nothing the engine can simulate.
 */
export function toMitigation(text: string, site: Candidate): Mitigation | null {
  try {
    const m = JSON.parse(text) as Mitigation;
    if (m && typeof m === 'object' && 'kind' in m) return m;
  } catch { /* free text */ }
  const t = text.toLowerCase();
  const [lng, lat] = centroid(site);
  const label = text.slice(0, 80);
  if (/kiosk|express|satellite|grab/.test(t)) return { kind: 'kiosk', lng: lng + 0.0004, lat: lat + 0.0003, label };
  if (/delivery window|unloading window|bollard|before 0?7/.test(t)) return { kind: 'delivery_window', unlockRemovableBollards: true, label };
  if (/loading (point|bay|dock|zone)/.test(t)) return { kind: 'loading_point', lng: lng + 0.0003, lat, label };
  if (/layout|loop|spread|fairness|rotate/.test(t)) return { kind: 'stall_layout', layout: 'loop', label };
  return null;
}
