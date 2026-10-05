// Three.js view of the Altstadt twin: LoD2 buildings on DGM1 terrain, the candidate sites, and
// the selected site's simulation (trips, heat, bottlenecks, stalls).
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Color, Fog, PCFSoftShadowMap, type DirectionalLight, type PerspectiveCamera, Vector3 } from 'three';
import type { Candidate, SimulationResult, TimeSlice } from '../../contracts';
import { cameraPreset, type CameraMode, type Vec3 } from './camera';
import { getCity, type CityModel } from './city';
import { openRing, ringCenter, sampleElevation, toWorld } from './geometry';
import { Bottlenecks, Candidates, Heat, sliceOf, Stalls, Trips } from './layers';

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
function focusPoint(city: CityModel, candidate: Candidate | undefined): Vec3 {
  if (!candidate || candidate.polygon.length < 3) return [0, sampleElevation(...city.frame.origin, city.raster), 0];
  const center = ringCenter(openRing(candidate.polygon));
  return toWorld(center, city.frame, sampleElevation(center[0], center[1], city.raster));
}

/** Eases camera, target and lens to the preset, then hands control back to OrbitControls. */
function CameraRig({ mode, focus }: { mode: CameraMode; focus: Vec3 }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as Controls | null;
  const scene = useThree((state) => state.scene);
  const goal = useRef({ position: new Vector3(), target: new Vector3(), fov: 42, active: false });
  const [fx, fy, fz] = focus;
  useEffect(() => {
    const preset = cameraPreset(mode, [fx, fy, fz]);
    goal.current.position.set(...preset.position);
    goal.current.target.set(...preset.target);
    goal.current.fov = preset.fov;
    goal.current.active = true;
  }, [mode, fx, fy, fz]);
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
    const uniforms = city.focus;
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

function Scene({ city, props }: { city: CityModel; props: CityThreeProps }) {
  const { cameraMode, heatmap, selectedId, candidates, result, timeSec, onSelect } = props;
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  const focus = useMemo(() => focusPoint(city, selected), [city, selected]);
  const slice = result ? sliceOf(result, props.slice ?? DEFAULT_SLICE) : null;
  const stallSite = result ? candidates.find((candidate) => candidate.id === result.candidateId) : undefined;
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 600, 2600]} />
      <Lights focus={focus} />
      <Anisotropy city={city} />
      <primitive object={city.terrain} />
      <primitive object={city.buildings} />
      <Candidates city={city} candidates={candidates} selectedId={selectedId} onSelect={onSelect} />
      {result && result.trips.length > 0 && <Trips city={city} trips={result.trips} timeSec={timeSec} />}
      {heatmap && slice && slice.heat.length > 0 && <Heat city={city} heat={slice.heat} />}
      {slice && <Bottlenecks city={city} bottlenecks={slice.bottlenecks} />}
      {stallSite && result && result.stallExposure.length > 0 && (
        <Stalls city={city} candidate={stallSite} exposure={result.stallExposure} />
      )}
      <FocusGlow city={city} focus={focus} active={Boolean(selected)} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.495}
        minDistance={30} maxDistance={4200} />
      <CameraRig mode={cameraMode} focus={focus} />
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
  return (
    <div data-testid="city-three" data-ready={city ? 'true' : 'false'}
      data-building-count={city ? city.buildingCount : 0}
      className="relative h-full w-full overflow-hidden" style={{ background: BACKGROUND }}>
      {city && (
        <Canvas shadows={{ type: PCFSoftShadowMap }} dpr={[1, 2]}
          camera={{ position: initial.position, fov: initial.fov, near: 1, far: 9000 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ scene }) => { scene.background = new Color(BACKGROUND); }}>
          <Scene city={city} props={props} />
        </Canvas>
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
