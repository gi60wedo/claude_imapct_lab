import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../contracts';
import { toMitigation } from './mitigations';

const site = { id: 'X', polygon: [[11, 49], [11.001, 49], [11.001, 49.001], [11, 49.001]] } as unknown as Candidate;

describe('toMitigation', () => {
  it('maps free text to engine mitigations', () => {
    expect(toMitigation('Add 3 express fruit kiosks at the U-Bahn exit', site)?.kind).toBe('kiosk');
    expect(toMitigation('Delivery window before 07:00 with removable bollards', site)).toMatchObject({ kind: 'delivery_window', unlockRemovableBollards: true });
    expect(toMitigation('Designate a loading bay on the side street', site)?.kind).toBe('loading_point');
    expect(toMitigation('Rotate stall layout to a loop', site)).toMatchObject({ kind: 'stall_layout', layout: 'loop' });
  });
  it('passes structured JSON through and returns null for unknown text', () => {
    expect(toMitigation(JSON.stringify({ kind: 'kiosk', lng: 1, lat: 2 }), site)).toEqual({ kind: 'kiosk', lng: 1, lat: 2 });
    expect(toMitigation('Hold a town hall meeting', site)).toBeNull();
  });
});
