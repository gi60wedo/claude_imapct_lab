import type { Candidate } from '../contracts.ts';

export interface FilterThresholds {
  minAreaM2: number;     // a 40-stall market needs at least this much open or floor area
  maxStopWalkM: number;  // walking distance to the nearest stop with Saturday service
  maxVanDistM: number;   // trolley distance from a legal 05:30 van stop
}

export const DEFAULT_THRESHOLDS: FilterThresholds = { minAreaM2: 800, maxStopWalkM: 400, maxVanDistM: 80 };

const m = (v: number) => `${Math.round(v)} m`;

/** Every reason the site fails, in a form the map tooltip can show as-is. Empty = passes. */
export function rejectReasons(c: Candidate, t: FilterThresholds = DEFAULT_THRESHOLDS): string[] {
  const ev = c.evidence;
  const out: string[] = [];
  if (ev?.manualExclusion) out.push(`Excluded by hand: ${ev.manualExclusion}`);

  if (c.areaM2 < t.minAreaM2) {
    const what = ev?.baseKind === 'ground_floor' ? 'floor area' : 'open area';
    out.push(`Too small: ${Math.round(c.areaM2)} m² ${what} (needs ${t.minAreaM2} m²)`);
  }

  const stop = ev?.nearestStop;
  if (!stop) out.push(`No transit stop reachable on foot`);
  else if (stop.walkM > t.maxStopWalkM)
    out.push(`No transit stop within a ${m(t.maxStopWalkM)} walk (nearest: ${stop.name}, ${m(stop.walkM)})`);

  // vanDistM >= 0 already implies a legal route in and back out; deliveryAccess is the same test at 80 m
  const { vanDistM } = c.indicators;
  if (vanDistM < 0 || vanDistM > t.maxVanDistM) {
    const b = ev?.blockedBy;
    const blocker = b ? `${b.restriction}${b.street ? ` on ${b.street}` : ''}` : null;
    if (vanDistM < 0) out.push(`No van access at 05:30${blocker ? `: ${blocker}` : ''}`);
    else out.push(`Van can only stop ${m(vanDistM)} away (max ${m(t.maxVanDistM)})${blocker ? `; ${blocker}` : ''}`);
  }
  return out;
}
