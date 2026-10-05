// Per-frame scene layers on top of the static city: candidate plates, trips, heat, bottlenecks
// and stalls. Every size, colour intensity and count derives from the props; nothing is typed in.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DoubleSide, Float32BufferAttribute, type InstancedMesh, type Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, RingGeometry, ShapeGeometry, SphereGeometry,
} from 'three';
import type { Bottleneck, Candidate, PersonaId, SimulationResult, TimeSlice } from '../../contracts';
import type { CityModel } from './city';
import {
  footprintShape, heatColor, openRing, project, ringCenter, sampleElevation, sampleTrip,
  stallGrid, toWorld, unproject, type LngLat, type TripPoint,
} from './geometry';

export const PERSONA_COLORS: Record<PersonaId, string> = {
  senior: '#8b5cf6', vendor: '#f97316', commuter: '#3b82f6', retailer: '#9ca3af',
};

const ground = (city: CityModel, [lng, lat]: LngLat) => sampleElevation(lng, lat, city.raster);
const scratch = new Object3D();
const hidden = new Object3D();
hidden.scale.setScalar(0);
hidden.updateMatrix();

/** Selected and rank-one sites glow brightest; failed sites stay a dim rose. */
function candidateColor(candidate: Candidate, selected: boolean, maxRank: number) {
  if (selected) return new Color('#67e8f9');
  if (!candidate.passedFilter) return new Color('#f43f5e');
  if (candidate.kind === 'benchmark') return new Color('#a78bfa');
  if (candidate.quickRank === undefined || maxRank <= 1) return new Color('#22d3ee');
  return new Color('#34d399').lerp(new Color('#0ea5e9'), (candidate.quickRank - 1) / (maxRank - 1));
}

function CandidateSite({ city, candidate, selected, maxRank, onSelect }: {
  city: CityModel; candidate: Candidate; selected: boolean; maxRank: number; onSelect?: (id: string) => void;
}) {
  const plate = useRef<MeshBasicMaterial>(null);
  const { shape, outline, y, center } = useMemo(() => {
    const ring = openRing(candidate.polygon);
    const top = Math.max(...ring.map((point) => ground(city, point))) + 0.5;
    const points = [...ring, ring[0]].flatMap((point) => toWorld(point, city.frame, top + 0.15));
    const line = new BufferGeometry();
    line.setAttribute('position', new Float32BufferAttribute(points, 3));
    const c = ringCenter(ring);
    return { shape: new ShapeGeometry(footprintShape([ring], city.frame)), outline: line, y: top,
      center: toWorld(c, city.frame, top) };
  }, [city, candidate.polygon]);
  useLayoutEffect(() => () => { shape.dispose(); outline.dispose(); }, [shape, outline]);
  const color = candidateColor(candidate, selected, maxRank);
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
      <mesh geometry={shape} rotation-x={-Math.PI / 2} position-y={y} onClick={click}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}>
        <meshBasicMaterial ref={plate} color={color} transparent opacity={base} side={DoubleSide}
          depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
      </mesh>
      <lineLoop geometry={outline} renderOrder={10}>
        <lineBasicMaterial color={color} transparent opacity={selected ? 1 : 0.75}
          depthTest={false} toneMapped={false} />
      </lineLoop>
      {selected && (
        <>
          <mesh position={[center[0], y + 60, center[2]]}>
            <cylinderGeometry args={[1.2, 5, 120, 16, 1, true]} />
            <meshBasicMaterial color={color} transparent opacity={0.22} blending={AdditiveBlending}
              depthWrite={false} side={DoubleSide} toneMapped={false} />
          </mesh>
          <Html position={[center[0], y + 128, center[2]]} center zIndexRange={[10, 0]}>
            <span data-bind="candidate.name"
              className="whitespace-nowrap rounded border border-cyan-300/40 bg-slate-950/80 px-2 py-0.5 font-mono text-xs text-cyan-200">
              {candidate.name}
            </span>
          </Html>
        </>
      )}
    </group>
  );
}

export function Candidates({ city, candidates, selectedId, onSelect }: {
  city: CityModel; candidates: Candidate[]; selectedId: string | null; onSelect?: (id: string) => void;
}) {
  const maxRank = Math.max(1, ...candidates.map((c) => c.quickRank ?? 1));
  return (
    <group name="candidates">
      {candidates.filter((c) => c.polygon.length >= 3).map((candidate) => (
        <CandidateSite key={candidate.id} city={city} candidate={candidate} maxRank={maxRank}
          selected={candidate.id === selectedId} onSelect={onSelect} />
      ))}
    </group>
  );
}

const TRAIL = 7;
const TRAIL_STEP_S = 5;

/** Instanced agent dots: a bright head plus fading ghosts at earlier sim times. */
export function Trips({ city, trips, timeSec }: {
  city: CityModel; trips: SimulationResult['trips']; timeSec: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const time = useRef(timeSec);
  time.current = timeSec;
  const paths = useMemo(() => trips.map((trip) => trip.path.map(([lng, lat, t]): TripPoint => {
    const [x, y, z] = toWorld([lng, lat], city.frame, ground(city, [lng, lat]) + 1.6);
    return { x, y, z, time: t };
  })), [city, trips]);
  const count = Math.max(1, trips.length * TRAIL);
  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    const color = new Color();
    trips.forEach((trip, i) => {
      for (let k = 0; k < TRAIL; k++) {
        color.set(PERSONA_COLORS[trip.persona] ?? '#e5e7eb').multiplyScalar((1 - k / TRAIL) ** 1.6 * 1.4);
        target.setColorAt(i * TRAIL + k, color);
      }
    });
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
  }, [trips, count]);
  useFrame(() => {
    const target = mesh.current;
    if (!target) return;
    paths.forEach((path, i) => {
      for (let k = 0; k < TRAIL; k++) {
        const p = sampleTrip(path, time.current - k * TRAIL_STEP_S);
        if (!p) { target.setMatrixAt(i * TRAIL + k, hidden.matrix); continue; }
        scratch.position.set(p.x, p.y, p.z);
        scratch.scale.setScalar(k === 0 ? 1 : 0.85 - (0.5 * k) / TRAIL);
        scratch.updateMatrix();
        target.setMatrixAt(i * TRAIL + k, scratch.matrix);
      }
    });
    target.count = trips.length * TRAIL;
    target.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh key={count} ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[2, 10, 8]} />
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

/** Heat for one slice: a ground-draped glow disc and a light column per weighted point. */
export function Heat({ city, heat }: { city: CityModel; heat: [number, number, number][] }) {
  const discs = useRef<InstancedMesh>(null);
  const columns = useRef<InstancedMesh>(null);
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
      const y = ground(city, [lng, lat]);
      color.setRGB(...heatColor(t));
      scratch.position.set(x, y + 0.8, z);
      scratch.scale.set(14 + 26 * t, 1, 14 + 26 * t);
      scratch.updateMatrix();
      discs.current?.setMatrixAt(i, scratch.matrix);
      discs.current?.setColorAt(i, color.clone().multiplyScalar(0.35 + 0.65 * t));
      scratch.position.set(x, y, z);
      scratch.scale.set(2.2, 3 + 45 * t, 2.2);
      scratch.updateMatrix();
      columns.current?.setMatrixAt(i, scratch.matrix);
      columns.current?.setColorAt(i, color.clone().multiplyScalar(0.25 + 0.75 * t));
    });
    for (const target of [discs.current, columns.current]) {
      if (!target) continue;
      target.count = heat.length;
      target.instanceMatrix.needsUpdate = true;
      if (target.instanceColor) target.instanceColor.needsUpdate = true;
    }
  }, [city, heat, count]);
  return (
    <group name="heat">
      <instancedMesh key={`d${count}`} ref={discs} args={[discGeometry, undefined, count]} frustumCulled={false}>
        <meshBasicMaterial map={radialGlow()} transparent blending={AdditiveBlending} depthWrite={false}
          toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`c${count}`} ref={columns} args={[columnGeometry, undefined, count]} frustumCulled={false}>
        <meshBasicMaterial transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false}
          toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

const markerSphere = new SphereGeometry(1, 16, 12);
const markerRing = new RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);
const markerBeam = new CylinderGeometry(0.4, 0.4, 1, 8, 1, true).translate(0, 0.5, 0);

function BottleneckMarker({ city, bottleneck, phase }: { city: CityModel; bottleneck: Bottleneck; phase: number }) {
  const ring = useRef<Mesh>(null);
  const core = useRef<Mesh>(null);
  const point: LngLat = [bottleneck.lng, bottleneck.lat];
  const [x, , z] = toWorld(point, city.frame);
  const y = ground(city, point);
  const severity = Math.max(0, Math.min(1, bottleneck.severity));
  const radius = 2.5 + 5 * severity;
  useFrame(({ clock }) => {
    const wave = (clock.elapsedTime * 0.8 + phase) % 1;
    if (ring.current) {
      ring.current.scale.setScalar(radius * (1.2 + 3.5 * wave));
      (ring.current.material as MeshBasicMaterial).opacity = 0.9 * (1 - wave);
    }
    if (core.current) core.current.scale.setScalar(radius * (0.85 + 0.15 * Math.sin(clock.elapsedTime * 5 + phase * 6.28)));
  });
  return (
    <group position={[x, y, z]}>
      <mesh ref={core} geometry={markerSphere} position-y={radius + 1}>
        <meshBasicMaterial color="#ef4444" toneMapped={false} />
      </mesh>
      <mesh ref={ring} geometry={markerRing} position-y={0.6}>
        <meshBasicMaterial color="#f87171" transparent blending={AdditiveBlending} depthWrite={false}
          side={DoubleSide} toneMapped={false} />
      </mesh>
      <mesh geometry={markerBeam} scale={[1, 20 + 60 * severity, 1]}>
        <meshBasicMaterial color="#ef4444" transparent opacity={0.35} blending={AdditiveBlending}
          depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Bottlenecks({ city, bottlenecks }: { city: CityModel; bottlenecks: Bottleneck[] }) {
  return (
    <group name="bottlenecks">
      {bottlenecks.map((bottleneck, i) => (
        <BottleneckMarker key={`${bottleneck.lng}:${bottleneck.lat}:${i}`} city={city} bottleneck={bottleneck}
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
export function Stalls({ city, candidate, exposure }: { city: CityModel; candidate: Candidate; exposure: number[] }) {
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
      scratch.position.set(east, ground(city, unproject([east, north], city.frame)) + 0.55, -north);
      scratch.scale.set(size, 1 + 3 * t, size * 0.7);
      scratch.updateMatrix();
      target.setMatrixAt(i, scratch.matrix);
      target.setColorAt(i, color.setRGB(...heatColor(t)));
    });
    target.count = cells.length;
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
  }, [city, candidate.polygon, exposure, count]);
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
