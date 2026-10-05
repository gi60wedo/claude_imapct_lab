// Three.js view of the Altstadt twin as a dark monochrome map: the LoD2 buildings as flat grey
// massing on a near-black DGM1 terrain, grey streets by road class, the candidate sites in white
// and grey, and the selected site's simulation (agent dots, heat, bottlenecks, stalls). The agent
// dots carry the only colour.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Fog, type LineSegments, PCFShadowMap, type PerspectiveCamera,
  Uint32BufferAttribute, Vector3,
} from 'three';
import type { Candidate, SimulationResult, TimeSlice } from '../../contracts';
import { cameraPreset, SIDE_LIFT, type CameraMode, type Vec3 } from './camera';
import { getCity, upgradeRoofs, type CityModel } from './city';
import { AdaptiveResolution, Effects } from './effects';
import { Bottlenecks, Candidates, ground, Heat, LABEL_LIFT_M, siteAnchor, sliceOf, Stalls, Trips } from './layers';
import { Lights } from './lighting';
import { sectionFor, SectionClip, SectionProfile } from './section';
import { getStreets, ROAD_LIFT_M, STREET_LIFT_M, type LineSet, type RoadMesh, type Streets } from './streets';
import { CAMERA_TWEEN_S, easeInOutCubic, MAP, SURFACES, type AgentColors, type Quality } from './style';

export type { CameraMode } from './camera';
export type { AgentColors, Quality } from './style';

export interface CityThreeProps {
  cameraMode: CameraMode; heatmap: boolean;
  selectedId: string | null;            // candidate to focus and highlight
  candidates: Candidate[];
  result: SimulationResult | null;      // trips, heat, bottlenecks, stalls for selectedId
  timeSec: number;                      // sim time, drives trip animation
  onSelect?: (id: string) => void;
  /**
   * Heat and bottleneck slice. Optional extension of the shared props, which carry no slice.
   * TODO(subagent): contract needs the active TimeSlice in CityThreeProps (dashboard schedule).
   */
  slice?: TimeSlice;
  /** Render tier: 'high' adds MSAA, ambient occlusion and larger shadow maps. Default 'high'. */
  quality?: Quality;
  /** Footway overlay in greys by surface (sett dashed). The grey road network is always drawn. Default false. */
  streets?: boolean;
  /** Agent dots in persona colours or all white. Default 'persona'. */
  agentColors?: AgentColors;
}

const BACKGROUND = MAP.background;
const DEFAULT_SLICE: TimeSlice = '11:30_PEAK';
const NO_HEAT: [number, number, number][] = [];

interface Controls {
  target: Vector3; update(): void;
  addEventListener(type: 'start', listener: () => void): void;
  removeEventListener(type: 'start', listener: () => void): void;
}

/** Focus point for the camera and the light: the selected site's centroid on terrain. */
function focusPoint(city: CityModel, candidate: Candidate | undefined, lift: number): Vec3 {
  if (!candidate || candidate.polygon.length < 3) return [0, ground(city, city.frame.origin, lift), 0];
  return siteAnchor(city, candidate, lift);
}

/**
 * Tweens camera, target and lens to the preset over CAMERA_TWEEN_S with an ease-in-out, then
 * hands control back to the damped OrbitControls. Grabbing the controls interrupts the tween; a
 * new preset mid-tween restarts from wherever the camera is.
 */
function CameraRig({ mode, focus, forward }: { mode: CameraMode; focus: Vec3; forward: [number, number] }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as Controls | null;
  const scene = useThree((state) => state.scene);
  const tween = useRef({
    from: { position: new Vector3(), target: new Vector3(), fov: 42 },
    to: { position: new Vector3(), target: new Vector3(), fov: 42 },
    elapsed: 0, active: false, pending: true,
  });
  const [fx, fy, fz] = focus;
  const [dx, dz] = forward;
  useEffect(() => {
    const preset = cameraPreset(mode, [fx, fy, fz], [dx, dz]);
    const t = tween.current;
    t.to.position.set(...preset.position);
    t.to.target.set(...preset.target);
    t.to.fov = preset.fov;
    // The start pose is captured on the next frame, once the controls exist.
    t.pending = true;
  }, [mode, fx, fy, fz, dx, dz]);
  useEffect(() => {
    if (!controls) return;
    const stop = () => { tween.current.active = false; tween.current.pending = false; };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);
  useFrame((_, delta) => {
    if (!controls) return;
    const t = tween.current;
    if (t.pending) {
      t.from.position.copy(camera.position);
      t.from.target.copy(controls.target);
      t.from.fov = camera.fov;
      t.elapsed = 0;
      t.active = true;
      t.pending = false;
    }
    if (t.active) {
      t.elapsed += Math.min(delta, 0.1);
      const progress = Math.min(1, t.elapsed / CAMERA_TWEEN_S);
      const e = easeInOutCubic(progress);
      camera.position.lerpVectors(t.from.position, t.to.position, e);
      controls.target.lerpVectors(t.from.target, t.to.target, e);
      camera.fov = t.from.fov + (t.to.fov - t.from.fov) * e;
      camera.updateProjectionMatrix();
      controls.update();
      if (progress >= 1) t.active = false;
    }
    // Fog follows the viewing distance so the top view is not swallowed and the oblique view
    // still fades the far city into the night.
    if (scene.fog instanceof Fog) {
      const distance = camera.position.distanceTo(controls.target);
      scene.fog.near = distance * 1.1;
      scene.fog.far = distance * 3.6 + 500;
    }
  });
  return null;
}

/** Surface lines draped on the terrain; the y scale applies the same lift as the terrain mesh. */
function SurfaceLines({ set, dashed, lift }: { set: LineSet; dashed: boolean; lift: number }) {
  const ref = useRef<LineSegments>(null);
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(set.positions, 3));
    g.setAttribute('color', new Float32BufferAttribute(set.colors, 3));
    g.computeBoundingSphere();
    return g;
  }, [set]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  // Dash distances accumulate along the segments in metres.
  useLayoutEffect(() => { if (dashed) ref.current?.computeLineDistances(); }, [dashed, geometry]);
  if (set.positions.length === 0) return null;
  return (
    <lineSegments ref={ref} geometry={geometry} scale-y={lift} position-y={STREET_LIFT_M} renderOrder={3}
      raycast={() => null} frustumCulled={false}>
      {dashed ? <lineDashedMaterial vertexColors transparent opacity={0.9} dashSize={2.2} gapSize={1.8} depthWrite={false} />
        : <lineBasicMaterial vertexColors transparent opacity={0.8} depthWrite={false} />}
    </lineSegments>
  );
}

/** Grey road ribbons on the terrain, painted in index order after the terrain and buildings. */
function Roads({ roads, lift }: { roads: RoadMesh; lift: number }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(roads.positions, 3));
    g.setAttribute('color', new Float32BufferAttribute(roads.colors, 3));
    g.setIndex(new Uint32BufferAttribute(roads.index, 1));
    g.computeBoundingSphere();
    return g;
  }, [roads]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} scale-y={lift} position-y={ROAD_LIFT_M} renderOrder={1} raycast={() => null}
      frustumCulled={false}>
      <meshBasicMaterial vertexColors side={DoubleSide} depthWrite={false} />
    </mesh>
  );
}

/** Applies the vertical exaggeration to the terrain mesh and the building shaders. */
function Lift({ city, lift }: { city: CityModel; lift: number }) {
  useEffect(() => {
    city.terrain.scale.y = lift;
    city.uniforms.uLift.value = lift;
  }, [city, lift]);
  return null;
}

/**
 * Pins a DOM label (rendered by CityThree outside the canvas) to a world point each frame.
 * drei <Html> mounts its own React root and unmounts it synchronously in a layout effect, which
 * React 19 reports as an error whenever the selected site changes.
 */
function LabelAnchor({ label, anchor }: { label: RefObject<HTMLDivElement | null>; anchor: Vec3 | null }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const point = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const element = label.current;
    if (!element) return;
    if (!anchor) { element.style.visibility = 'hidden'; return; }
    point.set(...anchor).project(camera);
    const onScreen = point.z < 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
    element.style.visibility = onScreen ? 'visible' : 'hidden';
    element.style.transform = `translate(${((point.x + 1) / 2) * size.width}px, ${((1 - point.y) / 2) * size.height}px) translate(-50%, -100%)`;
  });
  useEffect(() => () => { if (label.current) label.current.style.visibility = 'hidden'; }, [label]);
  return null;
}

function Scene({ city, props, label, streets, roofs, onAgentCount }: {
  city: CityModel; props: CityThreeProps; label: RefObject<HTMLDivElement | null>;
  streets: Streets | null; roofs: number; onAgentCount: (count: number) => void;
}) {
  const { cameraMode, heatmap, selectedId, candidates, result, timeSec, onSelect } = props;
  const quality = props.quality ?? 'high';
  const side = cameraMode === 'side';
  const lift = side ? SIDE_LIFT : 1;
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  const focus = useMemo(() => focusPoint(city, selected, lift), [city, selected, lift]);
  const section = useMemo(() => sectionFor(city, selected), [city, selected]);
  const anchor: Vec3 | null = selected ? [focus[0], focus[1] + LABEL_LIFT_M, focus[2]] : null;
  const activeSlice = props.slice ?? DEFAULT_SLICE;
  const slice = result ? sliceOf(result, activeSlice) : null;
  const stallSite = result ? candidates.find((candidate) => candidate.id === result.candidateId) : undefined;
  // Anything that changes what casts shadows, or how they are clipped, re-renders the shadow map.
  const shadowRevision = `${cameraMode}|${roofs}|${result?.candidateId ?? ''}|${result?.stallExposure.length ?? 0}`;
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 700, 2800]} />
      <Lift city={city} lift={lift} />
      <Lights focus={focus} slice={activeSlice} quality={quality} revision={shadowRevision} />
      <primitive object={city.terrain} />
      <primitive object={city.buildings} />
      {streets && <Roads roads={streets.roads} lift={lift} />}
      {streets && props.streets && <SurfaceLines set={streets.overlay.solid} dashed={false} lift={lift} />}
      {streets && props.streets && <SurfaceLines set={streets.overlay.dashed} dashed lift={lift} />}
      {side && <SectionClip section={section} />}
      {side && <SectionProfile city={city} section={section} lift={lift} />}
      <Candidates city={city} candidates={candidates} selectedId={selectedId} lift={lift} onSelect={onSelect} />
      {result && result.trips.length > 0 && (
        <Trips city={city} trips={result.trips} timeSec={timeSec} lift={lift} colors={props.agentColors ?? 'persona'}
          onCount={onAgentCount} />
      )}
      <Heat city={city} heat={slice?.heat ?? NO_HEAT} lift={lift} visible={heatmap} />
      {slice && <Bottlenecks key={activeSlice} city={city} bottlenecks={slice.bottlenecks} lift={lift} />}
      {stallSite && result && result.stallExposure.length > 0 && (
        <Stalls city={city} candidate={stallSite} exposure={result.stallExposure} lift={lift} />
      )}
      <LabelAnchor label={label} anchor={anchor} />
      {/* The side elevation looks horizontally, so it may orbit down to the horizon. */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.07} rotateSpeed={0.6} zoomSpeed={0.8}
        maxPolarAngle={side ? Math.PI / 2 : Math.PI * 0.495} minDistance={30} maxDistance={4200} />
      <CameraRig mode={cameraMode} focus={focus} forward={section.forward} />
      <AdaptiveResolution quality={quality} />
      <Effects quality={quality} />
    </>
  );
}

const GLASS = 'rounded-md border border-white/10 bg-black/55 backdrop-blur-md';

/** Legend for the street overlay: only the surface classes present in the data. */
function StreetLegend({ overlay }: { overlay: Streets['overlay'] }) {
  return (
    <div data-testid="street-legend" className={`${GLASS} px-2.5 py-1.5 font-mono text-[11px] text-zinc-300`}>
      <div className="mb-0.5 uppercase tracking-wider text-zinc-400">Footway surface</div>
      {SURFACES.filter((s) => overlay.present.includes(s.id)).map((s) => (
        <div key={s.id} className="flex items-center gap-2" data-surface={s.id}>
          <span className="inline-block w-5 border-t-2" style={{ borderColor: s.color, borderStyle: s.dashed ? 'dashed' : 'solid' }} />
          {s.label}
        </div>
      ))}
      <div className="mt-0.5 text-zinc-500">source: <span data-bind="streets.source">{overlay.source}</span></div>
    </div>
  );
}

export default function CityThree(props: CityThreeProps): JSX.Element {
  const [city, setCity] = useState<CityModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streetData, setStreetData] = useState<Streets | null>(null);
  const [roofs, setRoofs] = useState(0);
  useEffect(() => {
    let live = true;
    getCity().then(
      (model) => { if (live) setCity(model); },
      (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { live = false; };
  }, []);
  // Streets and roofs load after first paint, so the city appears as soon as it is built.
  useEffect(() => {
    if (!city) return;
    let live = true;
    getStreets(city).then((streets) => { if (live) setStreetData(streets); });
    upgradeRoofs(city).then((count) => { if (live) setRoofs(count); });
    return () => { live = false; };
  }, [city]);
  const initial = useMemo(() => cameraPreset('perspective', [0, 0, 0]), []);
  const label = useRef<HTMLDivElement>(null);
  const selected = props.candidates.find((candidate) => candidate.id === props.selectedId);
  const quality = props.quality ?? 'high';
  const streets = props.streets === true;
  const overlay = streetData?.overlay ?? null;
  // The dots are counted every frame; the count goes straight to the DOM, not through React state.
  const wrapper = useRef<HTMLDivElement>(null);
  const onAgentCount = useCallback((count: number) => {
    if (wrapper.current) wrapper.current.dataset.agentCount = String(count);
  }, []);
  return (
    <div ref={wrapper} data-testid="city-three" data-ready={city ? 'true' : 'false'}
      data-building-count={city ? city.buildingCount : 0} data-roof-count={roofs} data-quality={quality}
      data-streets={streets && overlay ? 'true' : 'false'} data-roads={streetData ? 'true' : 'false'}
      data-agent-count={0} data-agent-colors={props.agentColors ?? 'persona'}
      className="relative h-full w-full overflow-hidden" style={{ background: BACKGROUND }}>
      {city && (
        // MSAA and SMAA run in the composer, so the default framebuffer needs no antialiasing.
        <Canvas shadows={{ type: PCFShadowMap }} dpr={[1, 2]}
          camera={{ position: initial.position, fov: initial.fov, near: 1, far: 9000 }}
          gl={{ antialias: false, stencil: false, powerPreference: 'high-performance' }}
          onCreated={({ scene }) => { scene.background = new Color(BACKGROUND); }}>
          <Scene city={city} props={props} label={label} streets={streetData} roofs={roofs} onAgentCount={onAgentCount} />
        </Canvas>
      )}
      <div ref={label} className="pointer-events-none absolute left-0 top-0" style={{ visibility: 'hidden' }}
        data-testid="site-label">
        {selected && (
          <span data-bind="candidate.name"
            className="whitespace-nowrap rounded border border-white/70 bg-black/70 px-2 py-0.5 font-mono text-xs text-white">
            {selected.name}
          </span>
        )}
      </div>
      {city && (
        // Top centre, under the camera switch of the dashboard overlay.
        <div className="pointer-events-none absolute left-1/2 top-28 flex -translate-x-1/2 flex-col items-center gap-2">
          {streets && overlay && <StreetLegend overlay={overlay} />}
          {props.cameraMode === 'side' && (
            <div data-testid="side-legend" className={`${GLASS} px-2.5 py-1 font-mono text-[11px] text-zinc-300`}>
              Section through {selected ? <span data-bind="candidate.name">{selected.name}</span> : 'the city centre'}
              {' '}· vertical ×<span data-bind="cityThree.SIDE_LIFT">{SIDE_LIFT}</span> on terrain and building bases
            </div>
          )}
        </div>
      )}
      {!city && (
        <div className="absolute inset-0 grid place-items-center font-mono text-sm text-zinc-400">
          {error ? <span data-testid="city-three-error" className="text-rose-400">3D city failed to load: {error}</span>
            : <span className="animate-pulse">Loading 3D city…</span>}
        </div>
      )}
    </div>
  );
}
