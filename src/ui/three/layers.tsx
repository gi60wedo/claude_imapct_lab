// Per-frame scene layers on top of the static city: candidate outlines, agent dots, heat,
// bottlenecks and stalls. Everything but the agent dots is white or grey. Every size, intensity
// and count derives from the props; nothing is typed in. `lift` is the vertical exaggeration
// shared with the terrain and building bases.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, DynamicDrawUsage,
  Float32BufferAttribute, GreaterDepth, type Group, InstancedBufferAttribute, InstancedBufferGeometry, type InstancedMesh,
  type Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, RingGeometry, ShaderMaterial, ShapeGeometry, SphereGeometry, Vector2,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Bottleneck, Candidate, SimulationResult, TimeSlice } from '../../contracts';
import type { CityModel } from './city';
import {
  footprintShape, openRing, project, ringCenter, sampleElevation, samplePacked,
  stallGrid, trailLength, toWorld, unproject, type LngLat,
} from './geometry';
import { AGENT_WHITE, MAP, PERSONA_COLORS, type AgentColors } from './style';

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

/** Selected-site centre draped on the (lifted) terrain: the camera focus and the label base. */
export function siteAnchor(city: CityModel, candidate: Candidate, lift: number): [number, number, number] {
  const c = ringCenter(openRing(candidate.polygon));
  return toWorld(c, city.frame, ground(city, c, lift) + PLATE_LIFT_M);
}

/** Height of the selected site's name label above the site. */
export const LABEL_LIFT_M = 36;
const scratch = new Object3D();

/** Screen width of the selected site's outline, CSS pixels. */
const SELECTED_OUTLINE_PX = 2.5;

function CandidateSite({ city, candidate, selected, lift, onSelect }: {
  city: CityModel; candidate: Candidate; selected: boolean; lift: number;
  onSelect?: (id: string) => void;
}) {
  const dpr = useThree((state) => state.viewport.dpr);
  const { shape, outline, wide } = useMemo(() => {
    const ring = densify(openRing(candidate.polygon), city);
    const points = [...ring, ring[0]].flatMap((point) => toWorld(point, city.frame, ground(city, point, lift) + PLATE_LIFT_M + 0.15));
    const line = new BufferGeometry();
    line.setAttribute('position', new Float32BufferAttribute(points, 3));
    const wideGeometry = new LineGeometry();
    wideGeometry.setPositions(points);
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
    return { shape: plateGeometry, outline: line, wide: wideGeometry };
  }, [city, candidate, lift]);
  useLayoutEffect(() => () => { shape.dispose(); outline.dispose(); wide.dispose(); }, [shape, outline, wide]);
  // The selected site: a white outline a few pixels wide and a faint white fill, drawn over the
  // buildings so a ground-floor site still reads. Other sites: a thin grey outline.
  const wideLine = useMemo(() => {
    const material = new LineMaterial({ color: new Color(MAP.siteSelected), linewidth: SELECTED_OUTLINE_PX, depthTest: false, transparent: true });
    const line = new Line2(wide, material);
    line.renderOrder = 11;
    line.raycast = () => {};
    return line;
  }, [wide]);
  useLayoutEffect(() => () => wideLine.material.dispose(), [wideLine]);
  // LineMaterial widths are in drawing-buffer pixels.
  useLayoutEffect(() => { wideLine.material.linewidth = SELECTED_OUTLINE_PX * dpr; }, [wideLine, dpr]);
  const color = selected ? MAP.siteSelected : MAP.site;
  const fill = selected ? 0.12 : candidate.passedFilter ? 0.04 : 0.02;
  const click = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4) return;
    event.stopPropagation();
    onSelect?.(candidate.id);
  };
  return (
    <group>
      {/* Shape is in the (east, north) plane; rotating −90° about x maps north to −z. */}
      <mesh geometry={shape} rotation-x={-Math.PI / 2} onClick={click} renderOrder={9}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}>
        <meshBasicMaterial color={color} transparent opacity={fill} side={DoubleSide} depthWrite={false}
          depthTest={!selected} />
      </mesh>
      {selected ? <primitive object={wideLine} /> : (
        <lineLoop geometry={outline} renderOrder={10}>
          <lineBasicMaterial color={color} transparent opacity={candidate.passedFilter ? 0.55 : 0.3} depthTest={false} />
        </lineLoop>
      )}
      {/* The name label is a DOM overlay owned by CityThree (LabelAnchor), not drei <Html>. */}
    </group>
  );
}

export function Candidates({ city, candidates, selectedId, lift, onSelect }: {
  city: CityModel; candidates: Candidate[]; selectedId: string | null; lift: number; onSelect?: (id: string) => void;
}) {
  return (
    <group name="candidates">
      {candidates.filter((c) => c.polygon.length >= 3).map((candidate) => (
        <CandidateSite key={candidate.id} city={city} candidate={candidate} lift={lift}
          selected={candidate.id === selectedId} onSelect={onSelect} />
      ))}
    </group>
  );
}

/** Sim seconds between trail points. */
const TRAIL_STEP_S = 5;
/** Dot diameters in CSS pixels: the head, and the last trail point. Constant on screen. */
const HEAD_PX = 7;
const TAIL_PX = 2.5;
/** Opacity of the dot parts hidden behind buildings, drawn as a faint x-ray. */
const OCCLUDED_OPACITY = 0.3;
/** Dots float this far above the terrain. */
const DOT_LIFT_M = 1.6;

/** Flat [x, y, z, t] per path point, in world axes on the (lifted) terrain. */
function packPath(city: CityModel, path: [number, number, number][], lift: number) {
  const out = new Float32Array(path.length * 4);
  path.forEach(([lng, lat, t], i) => {
    const [x, y, z] = toWorld([lng, lat], city.frame, ground(city, [lng, lat], lift) + DOT_LIFT_M);
    out.set([x, y, z, t], i * 4);
  });
  return out;
}

// One camera-facing quad per instance, offset in clip space so the dot keeps its pixel size at
// any distance. `position` is the quad corner in [-1, 1].
const DOT_VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform vec2 uResolution;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vCorner;
#include <clipping_planes_pars_vertex>
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vCorner = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
  vec4 clip = projectionMatrix * mvPosition;
  clip.xy += position.xy * aSize * uPixelRatio / uResolution * clip.w;
  gl_Position = clip;
  #include <clipping_planes_vertex>
}`;

const DOT_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vCorner;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float r = dot(vCorner, vCorner);
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * uOpacity * (1.0 - smoothstep(0.5, 1.0, r)));
  #include <colorspace_fragment>
}`;

function dotMaterial(opacity: number, occluded: boolean) {
  return new ShaderMaterial({
    vertexShader: DOT_VERTEX, fragmentShader: DOT_FRAGMENT,
    uniforms: { uResolution: { value: new Vector2(1, 1) }, uPixelRatio: { value: 1 }, uOpacity: { value: opacity } },
    transparent: true, depthWrite: false, clipping: true,
    ...(occluded && { depthFunc: GreaterDepth }),
  });
}

/** Instanced quad with dynamic per-instance centre, colour, size and opacity for `capacity` dots. */
function dotGeometry(capacity: number) {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  for (const [name, size] of [['aCenter', 3], ['aColor', 3], ['aSize', 1], ['aAlpha', 1]] as const) {
    g.setAttribute(name, new InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(DynamicDrawUsage));
  }
  g.instanceCount = 0;
  return g;
}

/**
 * Agents as round dots of constant screen size, one per trip in the live result, on the real
 * clock: a dot shows while its trip is under way and moves at the trip's own pace. Each head has
 * a short trail of smaller, fainter dots at earlier sim times. All dots are instances of one quad,
 * so a full-scale run of a few thousand agents draws in two calls: every frame the visible
 * instances are packed to the front of the buffers, positions interpolated between path points.
 * Dots behind buildings stay visible as a faint x-ray. `onCount` receives the number of agents
 * drawn whenever it changes.
 */
export function Trips({ city, trips, timeSec, lift, colors, onCount }: {
  city: CityModel; trips: SimulationResult['trips']; timeSec: number; lift: number;
  colors: AgentColors; onCount?: (count: number) => void;
}) {
  const gl = useThree((state) => state.gl);
  const time = useRef(timeSec);
  time.current = timeSec;
  const report = useRef(onCount);
  report.current = onCount;
  const shown = useRef(-1);
  const trail = trailLength(trips.length);
  const paths = useMemo(() => trips.map((trip) => packPath(city, trip.path, lift)), [city, trips, lift]);
  const capacity = Math.max(1, trips.length * trail);
  const geometry = useMemo(() => dotGeometry(capacity), [capacity]);
  const materials = useMemo(() => ({ visible: dotMaterial(1, false), hidden: dotMaterial(OCCLUDED_OPACITY, true) }), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => () => { materials.visible.dispose(); materials.hidden.dispose(); }, [materials]);
  useEffect(() => () => { report.current?.(0); }, []);
  /** Linear colour per trip. */
  const palette = useMemo(() => {
    const out = new Float32Array(trips.length * 3);
    const color = new Color();
    trips.forEach((trip, i) => {
      color.set(colors === 'white' ? AGENT_WHITE : PERSONA_COLORS[trip.persona] ?? AGENT_WHITE).toArray(out, i * 3);
    });
    return out;
  }, [trips, colors]);
  /** Size and opacity per trail step: the head first, then smaller and fainter. */
  const steps = useMemo(() => Array.from({ length: trail }, (_, k) => {
    const f = trail > 1 ? k / (trail - 1) : 0;
    return k === 0 ? { size: HEAD_PX, alpha: 1 } : { size: HEAD_PX * 0.62 + (TAIL_PX - HEAD_PX * 0.62) * f, alpha: 0.55 * (1 - f) ** 1.4 + 0.06 };
  }), [trail]);
  const point = useMemo(() => new Float32Array(3), []);
  const buffer = useMemo(() => new Vector2(), []);
  useFrame(() => {
    const center = geometry.getAttribute('aCenter') as InstancedBufferAttribute;
    const color = geometry.getAttribute('aColor') as InstancedBufferAttribute;
    const size = geometry.getAttribute('aSize') as InstancedBufferAttribute;
    const alpha = geometry.getAttribute('aAlpha') as InstancedBufferAttribute;
    const c = center.array as Float32Array, col = color.array as Float32Array;
    const s = size.array as Float32Array, a = alpha.array as Float32Array;
    let visible = 0, heads = 0;
    for (let i = 0; i < paths.length; i++) {
      // Tail first, so each agent's head draws over its own trail.
      for (let k = trail - 1; k >= 0; k--) {
        if (!samplePacked(paths[i], time.current - k * TRAIL_STEP_S, point, 0)) continue;
        c[visible * 3] = point[0]; c[visible * 3 + 1] = point[1]; c[visible * 3 + 2] = point[2];
        col[visible * 3] = palette[i * 3]; col[visible * 3 + 1] = palette[i * 3 + 1]; col[visible * 3 + 2] = palette[i * 3 + 2];
        s[visible] = steps[k].size;
        a[visible] = steps[k].alpha;
        visible++;
        if (k === 0) heads++;
      }
    }
    geometry.instanceCount = visible;
    for (const attribute of [center, color, size, alpha]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, visible * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    gl.getDrawingBufferSize(buffer);
    for (const material of [materials.visible, materials.hidden]) {
      material.uniforms.uResolution.value.copy(buffer);
      material.uniforms.uPixelRatio.value = gl.getPixelRatio();
    }
    if (heads !== shown.current) { shown.current = heads; report.current?.(heads); }
  });
  return (
    <group name="agents">
      <mesh geometry={geometry} material={materials.hidden} frustumCulled={false} renderOrder={30} raycast={() => null} />
      <mesh geometry={geometry} material={materials.visible} frustumCulled={false} renderOrder={31} raycast={() => null} />
    </group>
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
 * Heat for one slice: a ground-draped grey glow per weighted point, brighter and wider with
 * weight. Opacity ramps toward 1 while `live` and toward 0 after, then the layer reports itself done.
 */
function HeatLayer({ city, heat, lift, live, onDone }: {
  city: CityModel; heat: HeatPoint[]; lift: number; live: boolean; onDone: () => void;
}) {
  const discs = useRef<InstancedMesh>(null);
  const discMaterial = useRef<MeshBasicMaterial>(null);
  const fade = useRef(0);
  const done = useRef(false);
  const count = Math.max(1, heat.length);
  const discGeometry = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  useLayoutEffect(() => () => discGeometry.dispose(), [discGeometry]);
  useLayoutEffect(() => {
    const max = Math.max(...heat.map((point) => point[2]), Number.EPSILON);
    const color = new Color();
    heat.forEach(([lng, lat, weight], i) => {
      const t = weight / max;
      const [x, , z] = toWorld([lng, lat], city.frame);
      scratch.position.set(x, ground(city, [lng, lat], lift) + 0.8, z);
      scratch.scale.set(14 + 26 * t, 1, 14 + 26 * t);
      scratch.updateMatrix();
      discs.current?.setMatrixAt(i, scratch.matrix);
      discs.current?.setColorAt(i, color.setScalar(0.04 + 0.2 * t));
    });
    const target = discs.current;
    if (target) {
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
    if (!live && fade.current === 0 && !done.current) { done.current = true; onDone(); }
  });
  return (
    <group name="heat">
      <instancedMesh key={`d${count}`} ref={discs} args={[discGeometry, undefined, count]} frustumCulled={false}>
        <meshBasicMaterial ref={discMaterial} map={radialGlow()} transparent opacity={0} blending={AdditiveBlending}
          depthWrite={false} />
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
const markerRing = new RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);
const markerBeam = new CylinderGeometry(0.4, 0.4, 1, 8, 1, true).translate(0, 0.5, 0);

/** A white core, a pulsing white ring on the ground and a faint grey stem, sized by severity. */
function BottleneckMarker({ city, bottleneck, phase, lift }: {
  city: CityModel; bottleneck: Bottleneck; phase: number; lift: number;
}) {
  const ring = useRef<Mesh>(null);
  const core = useRef<Mesh>(null);
  const point: LngLat = [bottleneck.lng, bottleneck.lat];
  const [x, , z] = toWorld(point, city.frame);
  const y = ground(city, point, lift);
  const severity = Math.max(0, Math.min(1, bottleneck.severity));
  const radius = 1.5 + 3 * severity;
  const group = useRef<Group>(null);
  const grow = useRef(0);
  useFrame(({ clock }, delta) => {
    // Markers grow in over half a second when a slice brings them in.
    grow.current = Math.min(1, grow.current + Math.min(delta, 0.1) / 0.5);
    group.current?.scale.setScalar(1 - (1 - grow.current) ** 3);
    const wave = (clock.elapsedTime * 0.6 + phase) % 1;
    if (ring.current) {
      ring.current.scale.setScalar(radius * (1.5 + 4 * wave));
      (ring.current.material as MeshBasicMaterial).opacity = 0.7 * (1 - wave);
    }
    if (core.current) core.current.scale.setScalar(radius * (0.85 + 0.15 * Math.sin(clock.elapsedTime * 4 + phase * 6.28)));
  });
  return (
    <group ref={group} position={[x, y, z]} scale={0}>
      <mesh ref={core} geometry={markerSphere} position-y={radius + 8 + 20 * severity}>
        <meshBasicMaterial color="#f4f4f5" />
      </mesh>
      <mesh ref={ring} geometry={markerRing} position-y={0.6}>
        <meshBasicMaterial color="#ffffff" transparent depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh geometry={markerBeam} scale={[1, radius + 8 + 20 * severity, 1]}>
        <meshBasicMaterial color="#a1a1aa" transparent opacity={0.35} depthWrite={false} />
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
 * One grey block per stallExposure slot on the site, taller and lighter with visitors per slot.
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
      target.setColorAt(i, color.setScalar(0.12 + 0.6 * t));
    });
    target.count = cells.length;
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
  }, [city, candidate.polygon, exposure, count, lift]);
  return (
    <instancedMesh key={count} ref={mesh} args={[geometry, undefined, count]} frustumCulled={false}
      renderOrder={insideBuilding ? 20 : 0} castShadow>
      <meshStandardMaterial roughness={1} depthTest={!insideBuilding} />
    </instancedMesh>
  );
}

export function sliceOf(result: SimulationResult, slice: TimeSlice) {
  return result.bySlice?.[slice] ?? { heat: [], bottlenecks: [] };
}
