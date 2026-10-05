import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TripsLayer } from '@deck.gl/geo-layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Bottleneck, SimulationResult } from '../../contracts';
import { buildSimLayers, BOTTLENECKS_LAYER_ID, KIOSKS_LAYER_ID } from '../map/simLayers';
import { startFps } from '../perf/fps';
import { getState, resultKey, setState } from '../state/store';
import SimOverlay from './SimOverlay';
import TimeControls from './TimeControls';

const mapView = vi.hoisted(() => vi.fn(() => null));
vi.mock('../map/MapView', () => ({ default: mapView }));

const initialState = getState();
let callbacks: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  callbacks = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
  history.replaceState(null, '', '/');
  mapView.mockClear();
});

afterEach(() => {
  cleanup();
  setState(initialState);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
  delete window.__fps;
});

function frame(now: number) {
  const pending = [...callbacks.values()];
  callbacks.clear();
  act(() => pending.forEach((callback) => callback(now)));
}

function result(): SimulationResult {
  const persona = { score: 50, served: 10, droppedOut: 2, topFriction: 'Crowding' };
  const bottlenecks: Bottleneck[] = [0.2, 0.8, 0.4, 1].map((severity, i) => ({
    lat: 49.45 + i * 0.001, lng: 11.07, severity, type: 'CROWDING', time: '11:35', cause: `Crowding ${i}`,
  }));
  return {
    candidateId: 'test', scenario: 'SUNNY_SAT', seed: 42, mitigations: [],
    criteria: { accessibility: 50, footfall: 50, fairness: 50, localBusiness: 50, walkability: 50 },
    personas: { senior: persona, vendor: persona, commuter: persona, retailer: persona },
    bySlice: {
      '05:30_DELIVERY': { heat: [[11.07, 49.45, 2]], bottlenecks: [] },
      '11:30_PEAK': { heat: [[11.08, 49.46, 7]], bottlenecks },
      '15:00_LULL': { heat: [], bottlenecks: [] },
    },
    stallExposure: [],
    trips: [{ persona: 'senior', path: [[11.07, 49.45, 10], [11.08, 49.46, 20]] }],
  };
}

test('layers separate coordinates and timestamps and retain result-owned data', () => {
  const data = result();
  const layers = buildSimLayers(data, '11:30_PEAK', 15);
  const trips = layers.find((layer) => layer instanceof TripsLayer)!;
  const heat = layers.find((layer) => layer instanceof HeatmapLayer)!;
  const markers = layers.find((layer) => layer instanceof ScatterplotLayer)!;
  expect(trips.props.data).toBe(data.trips);
  const context = { index: 0, data: data.trips, target: [] };
  expect(trips.props.getPath(data.trips[0], context)).toEqual([[11.07, 49.45], [11.08, 49.46]]);
  expect(trips.props.getTimestamps(data.trips[0], context)).toEqual([10, 20]);
  expect(trips.props.currentTime).toBe(15);
  expect(trips.props.trailLength).toBe(120);
  expect(heat.props.data).toBe(data.bySlice['11:30_PEAK'].heat);
  expect(markers.props.data).toBe(data.bySlice['11:30_PEAK'].bottlenecks);
  expect(markers.props.pickable).toBe(true);
  const radius = markers.props.getRadius as (point: Bottleneck) => number;
  expect(radius(data.bySlice['11:30_PEAK'].bottlenecks[3])).toBeGreaterThan(radius(data.bySlice['11:30_PEAK'].bottlenecks[0]));
  expect(layers.some((layer) => layer.id === KIOSKS_LAYER_ID)).toBe(false);
});

test('mitigation kiosks use the top three severities without mutating bottlenecks', () => {
  const data = result();
  data.mitigations = ['Add kiosks'];
  const original = [...data.bySlice['11:30_PEAK'].bottlenecks];
  const kiosk = buildSimLayers(data, '11:30_PEAK', 0).find((layer) => layer.id === KIOSKS_LAYER_ID)!;
  expect(kiosk.props.data).toEqual([original[3], original[1], original[2]]);
  expect(data.bySlice['11:30_PEAK'].bottlenecks).toEqual(original);
});

test('playback uses one frame loop, advances at 60x, wraps, pauses, and cleans up', () => {
  setState({ playing: true, timeSec: 3590 });
  const mounted = render(<TimeControls />);
  expect(callbacks.size).toBe(1);
  frame(1000);
  frame(1500);
  expect(getState().timeSec).toBe(20);
  expect(callbacks.size).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Pause simulation' }));
  expect(callbacks.size).toBe(0);
  frame(10000);
  expect(getState().timeSec).toBe(20);
  fireEvent.click(screen.getByRole('button', { name: 'Play simulation' }));
  frame(10000);
  expect(getState().timeSec).toBe(20);
  frame(10500);
  expect(getState().timeSec).toBe(50);
  mounted.unmount();
  expect(callbacks.size).toBe(0);
});

test('selecting a slice updates store state and restarts the slice clock', () => {
  setState({ playing: false, slice: '11:30_PEAK', timeSec: 500 });
  render(<TimeControls />);
  fireEvent.click(screen.getByRole('button', { name: '05:30' }));
  expect(getState().slice).toBe('05:30_DELIVERY');
  expect(getState().timeSec).toBe(0);
  expect(screen.getByRole('button', { name: '05:30' }).getAttribute('aria-pressed')).toBe('true');
});

test('overlay changes only trip currentTime while preserving static layers and data', () => {
  const data = result();
  setState({ selectedId: data.candidateId, scenario: data.scenario, slice: '11:30_PEAK', playing: false, results: { [resultKey(data.candidateId, data.scenario)]: data } });
  render(<SimOverlay />);
  const layers = () => (mapView.mock.calls.at(-1) as unknown as [{ extraLayers: ReturnType<typeof buildSimLayers> }])[0].extraLayers;
  const before = layers();
  act(() => setState({ timeSec: 90 }));
  const after = layers();
  for (let i = 0; i < before.length; i++) {
    const layer = after[i];
    expect(layer.props.data).toBe(before[i].props.data);
    if (layer instanceof TripsLayer) expect(layer.props.currentTime).toBe(90);
    else expect(layer).toBe(before[i]);
  }
  const marker = after.find((layer) => layer.id === BOTTLENECKS_LAYER_ID)!;
  act(() => marker.props.onHover!({ object: data.bySlice['11:30_PEAK'].bottlenecks[0], x: 10, y: 20 } as never, {} as never));
  expect(screen.getByRole('tooltip').textContent).toContain('Crowding 0');
  expect(screen.getByRole('tooltip').textContent).toContain('11:35');
  act(() => setState({ slice: '05:30_DELIVERY' }));
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(layers().find((layer) => layer instanceof HeatmapLayer)!.props.data).toBe(data.bySlice['05:30_DELIVERY'].heat);
});

test('FPS instrumentation is opt-in and keeps a rolling one-second window', () => {
  startFps()();
  expect(callbacks.size).toBe(0);
  history.replaceState(null, '', '/?perf=1');
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const stop = startFps();
  for (let i = 0; i <= 120; i++) frame(i * 1000 / 60);
  expect(window.__fps).toBeCloseTo(60);
  // A slow frame must affect the rolling window rather than retain the historic rate.
  frame(2500);
  expect(window.__fps).toBeLessThan(40);
  stop();
  expect(callbacks.size).toBe(0);
  expect(window.__fps).toBeUndefined();
});
