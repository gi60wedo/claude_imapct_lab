// Per-frame scene layers on top of the static city: candidate plates, trips, heat, bottlenecks
// and stalls. Every size, colour intensity and count derives from the props; nothing is typed in.
// `lift` is the vertical exaggeration shared with the terrain and building bases.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DoubleSide, Float32BufferAttribute, type Group, type InstancedMesh, type Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, RingGeometry, ShapeGeometry, SphereGeometry,
} from 'three';
import type { Bottleneck, Candidate, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import type { CityModel } from './city';
import {
  footprintShape, heatColor, openRing, project, ringCenter, sampleElevation, samplePacked,
  stallGrid, trailLength, toWorld, unproject, type LngLat,
} from './geometry';

export const PERSONA_COLORS: Record<PersonaId, string> = {
  senior: '#8b5cf6', vendor: '#f97316', commuter: '#3b82f6', retailer: '#9ca3af',
};

export const ground = (city: CityModel, [lng, lat]: LngLat, lift: number) => sampleElevation(lng, lat, city.raster) * lift;

/** Ring with extra vertices every `step` metres, so outlines and plates follow the terrain. */
function densify(ring: readonly LngLat[], city: CityModel, step = 3): LngLat[] {
  const out: LngLat[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const [ax, an] = project(a, city.frame), [bx, bn] = project(b, city.frame);
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bn - an) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  });
  return out;
}

const PLATE_LIFT_M = 0.5;

/** Selected-site centre draped on the (lifted) terrain: the base of the beam and label. */
export function siteAnchor(city: CityModel, candidate: Candidate, lift: number): [number, number, number] {
  const c = ringCenter(openRing(candidate.polygon));
  return toWorld(c, city.frame, ground(city, c, lift) + PLATE_LIFT_M);
}

/** Height of the selected site's light beam; the label sits just above it. */
export const BEAM_M = 120;
const scratch = new Object3D();

/** Selected and rank-one sites glow brightest; failed sites stay a dim rose. */
function candidateColor(candidate: Candidate, selected: boolean, maxRank: number) {
  if (selected) return new Color('#67e8f9');
  if (!candidate.passedFilter) return new Color('#f43f5e');
  if (candidate.kind === 'benchmark') return new Color('#a78bfa');
  if (candidate.quickRank === undefined || maxRank <= 1) return new Color('#22d3ee');
  return new Color('#34d399').lerp(new Color('#0ea5e9'), (candidate.quickRank - 1) / (maxRank - 1));
}

function CandidateSite({ city, candidate, selected, maxRank, lift, onSelect }: {
  city: CityModel; candidate: Candidate; selected: boolean; maxRank: number; lift: number;
  onSelect?: (id: string) => void;
}) {
  const plate = useRef<MeshBasicMaterial>(null);
  const { shape, outline, center } = useMemo(() => {
    const ring = densify(openRing(candidate.polygon), city);
    const points = [...ring, ring[0]].flatMap((point) => toWorld(point, city.frame, ground(city, point, lift) + PLATE_LIFT_M + 0.15));
    const line = new BufferGeometry();
    line.setAttribute('position', new Float32BufferAttribute(points, 3));
    // The plate lies in the (east, north) plane; its local z becomes world y after the −90° turn,
    // so each vertex is draped onto the terrain under it.
    const plateGeometry = new ShapeGeometry(footprintShape([ring], city.frame));
    const positions = plateGeometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const point = unproject([positions.getX(i), positions.getY(i)], city.frame);
      positions.setZ(i, ground(city, point, lift) + PLATE_LIFT_M);
    }
    positions.needsUpdate = true;
    plateGeometry.computeBoundingSphere();
    return { shape: plateGeometry, outline: line, center: siteAnchor(city, candidate, lift) };
  }, [city, candidate, lift]);
  useLayoutEffect(() => () => { shape.dispose(); outline.dispose(); }, [shape, outline]);
  const color = candidateColor(candidate, selected, maxRank);
  // The selected outline and beam are HDR (above the bloom threshold); other sites stay calm.
  const outlineColor = selected ? color.clone().multiplyScalar(2.6) : color;
  const base = selected ? 0.5 : candidate.passedFilter ? 0.28 : 0.14;
  useFrame(({ clock }) => {
    if (plate.current) plate.current.opacity = selected ? base + 0.18 * Math.sin(clock.elapsedTime * 2.4) : base;
  });
  const click = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4) return;
    event.stopPropagation();
    onSelect?.(candidate.id);
  };
  return (
    <group>
      {/* Shape is in the (east, north) plane; rotating −90° about x maps north to −z. */}
      <mesh geometry={shape} rotation-x={-Math.PI / 2} onClick={click}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}>
        <meshBasicMaterial ref={plate} color={color} transparent opacity={base} side={DoubleSide}
          depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
      </mesh>
      <lineLoop geometry={outline} renderOrder={10}>
        <lineBasicMaterial color={outlineColor} transparent opacity={selected ? 1 : 0.75}
          depthTest={false} toneMapped={false} />
      </lineLoop>
      {/* The name label is a DOM overlay owned by CityThree (LabelAnchor), not drei <Html>. */}
      {selected && (
        <mesh position={[center[0], center[1] + BEAM_M / 2, center[2]]}>
          <cylinderGeometry args={[1.2, 5, BEAM_M, 16, 1, true]} />
          <meshBasicMaterial color={outlineColor} transparent opacity={0.16} blending={AdditiveBlending}
            depthWrite={false} side={DoubleSide} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

export function Candidates({ city, candidates, selectedId, lift, onSelect }: {
  city: CityModel; candidates: Candidate[]; selectedId: string | null; lift: number; onSelect?: (id: string) => void;
}) {
  const maxRank = Math.max(1, ...candidates.map((c) => c.quickRank ?? 1));
  return (
    <group name="candidates">
      {candidates.filter((c) => c.polygon.length >= 3).map((candidate) => (
        <CandidateSite key={candidate.id} city={city} candidate={candidate} maxRank={maxRank} lift={lift}
          selected={candidate.id === selectedId} onSelect={onSelect} />
      ))}
    </group>
  );
}

const TRAIL_STEP_S = 5;
/** HDR gain on the head colour, so agents clear the bloom threshold and glow. */
const HEAD_GAIN = 2.4;
const TRIP_RADIUS_M = 1.8;

/** Flat [x, y, z, t] per path point, in world axes on the (lifted) terrain. */
function packPath(city: CityModel, path: [number, number, number][], lift: number) {
  const out = new Float32Array(path.length * 4);
  path.forEach(([lng, lat, t], i) => {
    const [x, y, z] = toWorld([lng, lat], city.frame, ground(city, [lng, lat], lift) + 1.6);
    out.set([x, y, z, t], i * 4);
  });
  return out;
}

/**
 * Agents as one instanced mesh sized for thousands of trips. Each frame the visible instances are
 * packed to the front (matrix and colour written straight into the instance buffers), so hidden
 * agents cost nothing and positions interpolate continuously between path points.
 */
export function Trips({ city, trips, timeSec, lift }: {
  city: CityModel; trips: SimulationResult['trips']; timeSec: number; lift: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const time = useRef(timeSec);
  time.current = timeSec;
  const trail = trailLength(trips.length);
  const paths = useMemo(() => trips.map((trip) => packPath(city, trip.path, lift)), [city, trips, lift]);
  const count = Math.max(1, trips.length * trail);
  /** Base colour per trip and trail step, HDR for the head. */
  const palette = useMemo(() => {
    const out = new Float32Array(trips.length * trail * 3);
    const color = new Color();
    trips.forEach((trip, i) => {
      for (let k = 0; k < trail; k++) {
        color.set(PERSONA_COLORS[trip.persona] ?? '#e5e7eb').multiplyScalar(k === 0 ? HEAD_GAIN : 1.1 * (1 - k / trail) ** 1.5);
        color.toArray(out, (i * trail + k) * 3);
      }
    });
    return out;
  }, [trips, trail]);
  const point = useMemo(() => new Float32Array(3), []);
  useLayoutEffect(() => {
    // setColorAt allocates the instance colour buffer; the frame loop then writes it directly.
    const target = mesh.current;
    if (target && !target.instanceColor) target.setColorAt(0, new Color());
  }, [count]);
  useFrame(() => {
    const target = mesh.current;
    if (!target || !target.instanceColor) return;
    const matrices = target.instanceMatrix.array as Float32Array;
    const colors = target.instanceColor.array as Float32Array;
    let visible = 0;
    for (let i = 0; i < paths.length; i++) {
      for (let k = 0; k < trail; k++) {
        if (!samplePacked(paths[i], time.current - k * TRAIL_STEP_S, point, 0)) continue;
        const scale = TRIP_RADIUS_M * (k === 0 ? 1 : 0.8 - (0.45 * k) / trail);
        const m = visible * 16;
        matrices.fill(0, m, m + 16);
        matrices[m] = matrices[m + 5] = matrices[m + 10] = scale;
        matrices[m + 12] = point[0]; matrices[m + 13] = point[1]; matrices[m + 14] = point[2]; matrices[m + 15] = 1;
        const c = (i * trail + k) * 3;
        colors[visible * 3] = palette[c]; colors[visible * 3 + 1] = palette[c + 1]; colors[visible * 3 + 2] = palette[c + 2];
        visible++;
      }
    }
    target.count = visible;
    target.instanceMatrix.needsUpdate = true;
    target.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh key={count} ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <icosahedronGeometry args={[1, 1]} />
      <meshBasicMaterial blending={AdditiveBlending} transparent depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}

let glowTexture: CanvasTexture | null = null;
/** Radial falloff sprite drawn once with a gradient: deterministic, no image asset. */
function radialGlow() {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

type HeatPoint = [number, number, number];
/** Seconds a heat layer takes to fade in or out when the slice or the toggle changes. */
const HEAT_FADE_S = 0.6;

/**
 * Heat for one slice: a ground-draped glow disc and a light column per weighted point. Opacity
 * ramps toward 1 while `live` and toward 0 after, then the layer reports itself done.
 */
function HeatLayer({ city, heat, lift, live, onDone }: {
  city: CityModel; heat: HeatPoint[]; lift: number; live: boolean; onDone: () => void;
}) {
  const discs = useRef<InstancedMesh>(null);
  const columns = useRef<InstancedMesh>(null);
  const discMaterial = useRef<MeshBasicMaterial>(null);
  const columnMaterial = useRef<MeshBasicMaterial>(null);
  const fade = useRef(0);
  const done = useRef(false);
  const count = Math.max(1, heat.length);
  const discGeometry = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const columnGeometry = useMemo(() => new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  useLayoutEffect(() => () => { discGeometry.dispose(); columnGeometry.dispose(); }, [discGeometry, columnGeometry]);
  useLayoutEffect(() => {
    const max = Math.max(...heat.map((point) => point[2]), Number.EPSILON);
    const color = new Color();
    heat.forEach(([lng, lat, weight], i) => {
      const t = weight / max;
      const [x, , z] = toWorld([lng, lat], city.frame);
      const y = ground(city, [lng, lat], lift);
      color.setRGB(...heatColor(t));
      scratch.position.set(x, y + 0.8, z);
      scratch.scale.set(14 + 26 * t, 1, 14 + 26 * t);
      scratch.updateMatrix();
      discs.current?.setMatrixAt(i, scratch.matrix);
      discs.current?.setColorAt(i, color.clone().multiplyScalar(0.5 + 1.1 * t));
      scratch.position.set(x, y, z);
      scratch.scale.set(2.2, 3 + 45 * t, 2.2);
      scratch.updateMatrix();
      columns.current?.setMatrixAt(i, scratch.matrix);
      columns.current?.setColorAt(i, color.clone().multiplyScalar(0.4 + 1.6 * t));
    });
    for (const target of [discs.current, columns.current]) {
      if (!target) continue;
      target.count = heat.length;
      target.instanceMatrix.needsUpdate = true;
      if (target.instanceColor) target.instanceColor.needsUpdate = true;
    }
  }, [city, heat, count, lift]);
  useFrame((_, delta) => {
    const step = Math.min(delta, 0.1) / HEAT_FADE_S;
    fade.current = Math.max(0, Math.min(1, fade.current + (live ? step : -step)));
    const eased = fade.current * fade.current * (3 - 2 * fade.current);
    if (discMaterial.current) discMaterial.current.opacity = eased;
    if (columnMaterial.current) columnMaterial.current.opacity = 0.55 * eased;
    if (!live && fade.current === 0 && !done.current) { done.current = true; onDone(); }
  });
  return (
    <group name="heat">
      <instancedMesh key={`d${count}`} ref={discs} args={[discGeometry, undefined, count]} frustumCulled={false}>
        <meshBasicMaterial ref={discMaterial} map={radialGlow()} transparent opacity={0} blending={AdditiveBlending}
          depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`c${count}`} ref={columns} args={[columnGeometry, undefined, count]} frustumCulled={false}>
        <meshBasicMaterial ref={columnMaterial} transparent opacity={0} blending={AdditiveBlending} depthWrite={false}
          toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/**
 * Cross-fades heat layers: a new slice (or switching the heatmap on) fades a layer in while the
 * previous one fades out; switching off fades the last layer out.
 */
export function Heat({ city, heat, lift, visible }: { city: CityModel; heat: HeatPoint[]; lift: number; visible: boolean }) {
  const shown = visible && heat.length > 0 ? heat : null;
  const next = useRef(0);
  const [layers, setLayers] = useState<{ id: number; heat: HeatPoint[]; live: boolean }[]>([]);
  useEffect(() => {
    setLayers((previous) => {
      const kept = previous.map((layer) => (layer.heat === shown ? layer : { ...layer, live: false }));
      if (!shown || kept.some((layer) => layer.heat === shown && layer.live)) return kept;
      return [...kept, { id: next.current++, heat: shown, live: true }];
    });
  }, [shown]);
  return (
    <>
      {layers.map((layer) => (
        <HeatLayer key={layer.id} city={city} heat={layer.heat} lift={lift} live={layer.live}
          onDone={() => setLayers((previous) => previous.filter((l) => l.id !== layer.id))} />
      ))}
    </>
  );
}

const markerSphere = new SphereGeometry(1, 16, 12);
/** HDR reds: bottlenecks are emissive and bloom. */
const BOTTLENECK_CORE = new Color('#ef4444').multiplyScalar(2.8);
const BOTTLENECK_RING = new Color('#f87171').multiplyScalar(1.8);
const markerRing = new RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);
const markerBeam = new CylinderGeometry(0.4, 0.4, 1, 8, 1, true).translate(0, 0.5, 0);

function BottleneckMarker({ city, bottleneck, phase, lift }: {
  city: CityModel; bottleneck: Bottleneck; phase: number; lift: number;
}) {
  const ring = useRef<Mesh>(null);
  const core = useRef<Mesh>(null);
  const point: LngLat = [bottleneck.lng, bottleneck.lat];
  const [x, , z] = toWorld(point, city.frame);
  const y = ground(city, point, lift);
  const severity = Math.max(0, Math.min(1, bottleneck.severity));
  const radius = 2.5 + 5 * severity;
  const group = useRef<Group>(null);
  const grow = useRef(0);
  useFrame(({ clock }, delta) => {
    // Markers grow in over half a second when a slice brings them in.
    grow.current = Math.min(1, grow.current + Math.min(delta, 0.1) / 0.5);
    group.current?.scale.setScalar(1 - (1 - grow.current) ** 3);
    const wave = (clock.elapsedTime * 0.8 + phase) % 1;
    if (ring.current) {
      ring.current.scale.setScalar(radius * (1.2 + 3.5 * wave));
      (ring.current.material as MeshBasicMaterial).opacity = 0.9 * (1 - wave);
    }
    if (core.current) core.current.scale.setScalar(radius * (0.85 + 0.15 * Math.sin(clock.elapsedTime * 5 + phase * 6.28)));
  });
  return (
    <group ref={group} position={[x, y, z]} scale={0}>
      <mesh ref={core} geometry={markerSphere} position-y={radius + 1}>
        <meshBasicMaterial color={BOTTLENECK_CORE} toneMapped={false} />
      </mesh>
      <mesh ref={ring} geometry={markerRing} position-y={0.6}>
        <meshBasicMaterial color={BOTTLENECK_RING} transparent blending={AdditiveBlending} depthWrite={false}
          side={DoubleSide} toneMapped={false} />
      </mesh>
      <mesh geometry={markerBeam} scale={[1, 20 + 60 * severity, 1]}>
        <meshBasicMaterial color="#ef4444" transparent opacity={0.35} blending={AdditiveBlending}
          depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Bottlenecks({ city, bottlenecks, lift }: { city: CityModel; bottlenecks: Bottleneck[]; lift: number }) {
  return (
    <group name="bottlenecks">
      {bottlenecks.map((bottleneck, i) => (
        <BottleneckMarker key={`${bottleneck.lng}:${bottleneck.lat}:${i}`} city={city} bottleneck={bottleneck} lift={lift}
          phase={bottlenecks.length ? i / bottlenecks.length : 0} />
      ))}
    </group>
  );
}

/**
 * One block per stallExposure slot on the site, height and colour by visitors per slot.
 * Positions are illustrative: the contract carries per-slot exposure but no stall coordinates.
 * TODO(subagent): contract needs stall positions (SimulationResult.stalls[].lng/lat).
 */
export function Stalls({ city, candidate, exposure, lift }: {
  city: CityModel; candidate: Candidate; exposure: number[]; lift: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const count = Math.max(1, exposure.length);
  const geometry = useMemo(() => new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const insideBuilding = candidate.kind === 'ground_floor';
  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    const ring = openRing(candidate.polygon).map((point) => project(point, city.frame));
    const cells = stallGrid(ring, exposure.length);
    const xs = ring.map((p) => p[0]), ns = ring.map((p) => p[1]);
    const spacing = Math.sqrt(((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ns) - Math.min(...ns))) /
      Math.max(1, exposure.length));
    const size = Math.max(1.2, Math.min(5, spacing * 0.55));
    const max = Math.max(...exposure, Number.EPSILON);
    const color = new Color();
    cells.forEach(([east, north], i) => {
      const t = exposure[i] / max;
      scratch.position.set(east, ground(city, unproject([east, north], city.frame), lift) + 0.55, -north);
      scratch.scale.set(size, 1 + 3 * t, size * 0.7);
      scratch.updateMatrix();
      target.setMatrixAt(i, scratch.matrix);
      target.setColorAt(i, color.setRGB(...heatColor(t)));
    });
    target.count = cells.length;
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
  }, [city, candidate.polygon, exposure, count, lift]);
  return (
    <instancedMesh key={count} ref={mesh} args={[geometry, undefined, count]} frustumCulled={false}
      renderOrder={insideBuilding ? 20 : 0} castShadow>
      <meshStandardMaterial emissive="#0b3b4a" emissiveIntensity={0.6} roughness={0.6}
        depthTest={!insideBuilding} toneMapped={false} />
    </instancedMesh>
  );
}

export function sliceOf(result: SimulationResult, slice: TimeSlice) {
  return result.bySlice?.[slice] ?? { heat: [], bottlenecks: [] };
}
