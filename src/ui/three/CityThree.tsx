// Three.js view of the Altstadt twin: LoD2 buildings on DGM1 terrain, the candidate sites, and
// the selected site's simulation (trips, heat, bottlenecks, stalls).
import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Color, Fog, PCFSoftShadowMap, type DirectionalLight, type PerspectiveCamera, Vector3 } from 'three';
import type { Candidate, SimulationResult, TimeSlice } from '../../contracts';
import { cameraPreset, SIDE_LIFT, type CameraMode, type Vec3 } from './camera';
import { getCity, type CityModel } from './city';
import { BEAM_M, Bottlenecks, Candidates, ground, Heat, siteAnchor, sliceOf, Stalls, Trips } from './layers';
import { sectionFor, SectionClip, SectionProfile } from './section';

export type { CameraMode } from './camera';

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
}

const BACKGROUND = '#050b18';
const DEFAULT_SLICE: TimeSlice = '11:30_PEAK';

interface Controls {
  target: Vector3; update(): void;
  addEventListener(type: 'start', listener: () => void): void;
  removeEventListener(type: 'start', listener: () => void): void;
}

/** Focus point for the camera and the building glow: the selected site's centroid on terrain. */
function focusPoint(city: CityModel, candidate: Candidate | undefined, lift: number): Vec3 {
  if (!candidate || candidate.polygon.length < 3) return [0, ground(city, city.frame.origin, lift), 0];
  return siteAnchor(city, candidate, lift);
}

/** Eases camera, target and lens to the preset, then hands control back to OrbitControls. */
function CameraRig({ mode, focus, forward }: { mode: CameraMode; focus: Vec3; forward: [number, number] }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as Controls | null;
  const scene = useThree((state) => state.scene);
  const goal = useRef({ position: new Vector3(), target: new Vector3(), fov: 42, active: false });
  const [fx, fy, fz] = focus;
  const [dx, dz] = forward;
  useEffect(() => {
    const preset = cameraPreset(mode, [fx, fy, fz], [dx, dz]);
    goal.current.position.set(...preset.position);
    goal.current.target.set(...preset.target);
    goal.current.fov = preset.fov;
    goal.current.active = true;
  }, [mode, fx, fy, fz, dx, dz]);
  useEffect(() => {
    if (!controls) return;
    const stop = () => { goal.current.active = false; };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);
  useFrame((_, delta) => {
    if (!controls) return;
    const g = goal.current;
    if (g.active) {
      const k = 1 - Math.exp(-Math.min(delta, 0.1) * 3.2);
      camera.position.lerp(g.position, k);
      controls.target.lerp(g.target, k);
      camera.fov += (g.fov - camera.fov) * k;
      camera.updateProjectionMatrix();
      controls.update();
      if (camera.position.distanceTo(g.position) < 0.3 && controls.target.distanceTo(g.target) < 0.3 &&
          Math.abs(camera.fov - g.fov) < 0.05) g.active = false;
    }
    // Fog follows the viewing distance so the top view is not swallowed and the oblique view
    // still fades the far city into the night.
    if (scene.fog instanceof Fog) {
      const distance = camera.position.distanceTo(controls.target);
      scene.fog.near = distance * 0.9;
      scene.fog.far = distance * 3.2 + 400;
    }
  });
  return null;
}

/** Eases the building glow toward the selected site. */
function FocusGlow({ city, focus, active }: { city: CityModel; focus: Vec3; active: boolean }) {
  useFrame((_, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 3);
    const uniforms = city.uniforms;
    uniforms.uFocus.value.lerp({ x: focus[0], y: focus[2] }, k);
    uniforms.uFocusStrength.value += ((active ? 1 : 0) - uniforms.uFocusStrength.value) * k;
  });
  return null;
}

function Lights({ focus }: { focus: Vec3 }) {
  const sun = useRef<DirectionalLight>(null);
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.target.position.set(...focus);
    light.target.updateMatrixWorld();
    light.position.set(focus[0] - 500, focus[1] + 800, focus[2] + 350);
  }, [focus]);
  return (
    <>
      <ambientLight color="#3b5b8f" intensity={0.35} />
      <hemisphereLight args={['#4a6fa5', '#02040a', 0.35]} />
      <directionalLight ref={sun} color="#9cc7ff" intensity={1.1} castShadow
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.6}
        shadow-camera-left={-900} shadow-camera-right={900} shadow-camera-top={900}
        shadow-camera-bottom={-900} shadow-camera-near={10} shadow-camera-far={2600} />
    </>
  );
}

function Anisotropy({ city }: { city: CityModel }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const material = city.terrain.material as { map?: { anisotropy: number; needsUpdate: boolean } };
    if (material.map) {
      material.map.anisotropy = gl.capabilities.getMaxAnisotropy();
      material.map.needsUpdate = true;
    }
  }, [city, gl]);
  return null;
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

function Scene({ city, props, label }: { city: CityModel; props: CityThreeProps; label: RefObject<HTMLDivElement | null> }) {
  const { cameraMode, heatmap, selectedId, candidates, result, timeSec, onSelect } = props;
  const side = cameraMode === 'side';
  const lift = side ? SIDE_LIFT : 1;
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  const focus = useMemo(() => focusPoint(city, selected, lift), [city, selected, lift]);
  const section = useMemo(() => sectionFor(city, selected), [city, selected]);
  const anchor: Vec3 | null = selected ? [focus[0], focus[1] + BEAM_M + 6, focus[2]] : null;
  const slice = result ? sliceOf(result, props.slice ?? DEFAULT_SLICE) : null;
  const stallSite = result ? candidates.find((candidate) => candidate.id === result.candidateId) : undefined;
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 600, 2600]} />
      <Lift city={city} lift={lift} />
      <Lights focus={focus} />
      <Anisotropy city={city} />
      <primitive object={city.terrain} />
      <primitive object={city.buildings} />
      {side && <SectionClip section={section} />}
      {side && <SectionProfile city={city} section={section} lift={lift} />}
      <Candidates city={city} candidates={candidates} selectedId={selectedId} lift={lift} onSelect={onSelect} />
      {result && result.trips.length > 0 && <Trips city={city} trips={result.trips} timeSec={timeSec} lift={lift} />}
      {heatmap && slice && slice.heat.length > 0 && <Heat city={city} heat={slice.heat} lift={lift} />}
      {slice && <Bottlenecks city={city} bottlenecks={slice.bottlenecks} lift={lift} />}
      {stallSite && result && result.stallExposure.length > 0 && (
        <Stalls city={city} candidate={stallSite} exposure={result.stallExposure} lift={lift} />
      )}
      <FocusGlow city={city} focus={focus} active={Boolean(selected)} />
      <LabelAnchor label={label} anchor={anchor} />
      {/* The side elevation looks horizontally, so it may orbit down to the horizon. */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08}
        maxPolarAngle={side ? Math.PI / 2 : Math.PI * 0.495} minDistance={30} maxDistance={4200} />
      <CameraRig mode={cameraMode} focus={focus} forward={section.forward} />
    </>
  );
}

export default function CityThree(props: CityThreeProps): JSX.Element {
  const [city, setCity] = useState<CityModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getCity().then(
      (model) => { if (live) setCity(model); },
      (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { live = false; };
  }, []);
  const initial = useMemo(() => cameraPreset('perspective', [0, 0, 0]), []);
  const label = useRef<HTMLDivElement>(null);
  const selected = props.candidates.find((candidate) => candidate.id === props.selectedId);
  return (
    <div data-testid="city-three" data-ready={city ? 'true' : 'false'}
      data-building-count={city ? city.buildingCount : 0}
      className="relative h-full w-full overflow-hidden" style={{ background: BACKGROUND }}>
      {city && (
        <Canvas shadows={{ type: PCFSoftShadowMap }} dpr={[1, 2]}
          camera={{ position: initial.position, fov: initial.fov, near: 1, far: 9000 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ scene }) => { scene.background = new Color(BACKGROUND); }}>
          <Scene city={city} props={props} label={label} />
        </Canvas>
      )}
      <div ref={label} className="pointer-events-none absolute left-0 top-0" style={{ visibility: 'hidden' }}
        data-testid="site-label">
        {selected && (
          <span data-bind="candidate.name"
            className="whitespace-nowrap rounded border border-cyan-300/40 bg-slate-950/80 px-2 py-0.5 font-mono text-xs text-cyan-200">
            {selected.name}
          </span>
        )}
      </div>
      {city && props.cameraMode === 'side' && (
        <div data-testid="side-legend"
          className="pointer-events-none absolute bottom-28 right-4 rounded border border-cyan-300/30 bg-slate-950/75 px-3 py-1.5 font-mono text-xs text-cyan-200">
          Section through {selected ? <span data-bind="candidate.name">{selected.name}</span> : 'the city centre'}
          {' '}· vertical ×<span data-bind="cityThree.SIDE_LIFT">{SIDE_LIFT}</span> on terrain and building bases
        </div>
      )}
      {!city && (
        <div className="absolute inset-0 grid place-items-center font-mono text-sm text-cyan-300/70">
          {error ? <span data-testid="city-three-error" className="text-rose-400">3D city failed to load: {error}</span>
            : <span className="animate-pulse">Loading 3D city…</span>}
        </div>
      )}
    </div>
  );
}
