// Side elevation: a vertical section through the selected site. A renderer clipping plane removes
// everything between the camera and the site, and a curtain along the cut draws the terrain
// profile, so the slope and the building silhouettes behind the site read from street level.
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial, Plane, Vector3 } from 'three';
import type { Candidate } from '../../contracts';
import type { CityModel } from './city';
import { facing, openRing, project, ringCenter, slopeAxis, unproject, type LngLat } from './geometry';
import { ground } from './layers';

export interface Section {
  /** Site centre in (east, north) metres. */
  origin: [number, number];
  /** Unit (east, north) axis the profile runs along: screen-right for the viewer. */
  axis: [number, number];
  /** Unit world (x, z) direction the camera looks in. */
  forward: [number, number];
  /** The site's extent along the axis, metres from the origin. */
  span: [number, number];
}

/** Profile axis across the site's steepest slope, sampled at the site's own scale. */
export function sectionFor(city: CityModel, candidate: Candidate | undefined): Section {
  const ring = candidate && candidate.polygon.length >= 3 ? openRing(candidate.polygon) : null;
  const center: LngLat = ring ? ringCenter(ring) : city.frame.origin;
  const origin = project(center, city.frame);
  const local = ring ? ring.map((p) => project(p, city.frame)) : [];
  const radius = Math.max(30, ...local.map(([e, n]) => Math.hypot(e - origin[0], n - origin[1])));
  const axis = slopeAxis(center, city.raster, city.frame, radius);
  const along = local.map(([e, n]) => (e - origin[0]) * axis[0] + (n - origin[1]) * axis[1]);
  const [fe, fn] = facing(axis);
  return {
    origin, axis, forward: [fe, -fn],
    span: along.length ? [Math.min(...along), Math.max(...along)] : [0, 0],
  };
}

/** Clips the scene to the far side of the plane through the site, while mounted. */
export function SectionClip({ section }: { section: Section }) {
  const gl = useThree((state) => state.gl);
  const [fx, fz] = section.forward;
  const [e, n] = section.origin;
  useEffect(() => {
    const normal = new Vector3(fx, 0, fz);
    gl.clippingPlanes = [new Plane(normal, -normal.dot(new Vector3(e, 0, -n)))];
    return () => { gl.clippingPlanes = []; };
  }, [gl, fx, fz, e, n]);
  return null;
}

const HALF_LENGTH_M = 900;
const STEP_M = 4;
/** Keeps the curtain just behind the clipping plane so it is never clipped itself. */
const BEHIND_M = 0.3;
const BAND_M = 2;
const DEPTH_M = 80;
const TICK_M = 26;

const SITE = new Color('#a5f3fc'), PROFILE = new Color('#22d3ee');
const BAND = new Color('#0e7490'), FLOOR = new Color('#040a16');

/** Terrain profile curtain along the cut, the site's stretch highlighted, with edge ticks. */
export function SectionProfile({ city, section, lift }: { city: CityModel; section: Section; lift: number }) {
  const { curtain, profile, ticks } = useMemo(() => {
    const { origin: [e0, n0], axis: [ae, an], forward: [fx, fz], span: [s0, s1] } = section;
    const columns = Math.round((2 * HALF_LENGTH_M) / STEP_M) + 1;
    const at = (s: number) => {
      const east = e0 + ae * s, north = n0 + an * s;
      return { x: east + fx * BEHIND_M, z: -north + fz * BEHIND_M, y: ground(city, unproject([east, north], city.frame), lift) };
    };
    const samples = Array.from({ length: columns }, (_, i) => -HALF_LENGTH_M + i * STEP_M).map((s) => ({ s, ...at(s) }));
    const floor = Math.min(...samples.map((p) => p.y)) - DEPTH_M;
    const positions: number[] = [], colors: number[] = [], index: number[] = [];
    for (const { s, x, y, z } of samples) {
      const onSite = s >= s0 && s <= s1;
      positions.push(x, y, z, x, y - BAND_M, z, x, floor, z);
      colors.push(...(onSite ? SITE : PROFILE).toArray(), ...BAND.toArray(), ...FLOOR.toArray());
    }
    for (let i = 0; i < columns - 1; i++) {
      for (let r = 0; r < 2; r++) {
        const a = i * 3 + r, b = (i + 1) * 3 + r;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const curtainGeometry = new BufferGeometry();
    curtainGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    curtainGeometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    curtainGeometry.setIndex(index);
    const profileGeometry = new BufferGeometry();
    profileGeometry.setAttribute('position', new Float32BufferAttribute(
      samples.flatMap(({ x, y, z }) => [x, y + 0.2, z]), 3));
    const tickGeometry = new BufferGeometry();
    tickGeometry.setAttribute('position', new Float32BufferAttribute(
      [s0, s1].flatMap((s) => { const p = at(s); return [p.x, p.y, p.z, p.x, p.y + TICK_M, p.z]; }), 3));
    // A polyline as a primitive: JSX <line> resolves to the SVG element type.
    const profileLine = new Line(profileGeometry, new LineBasicMaterial({ color: PROFILE, fog: false, toneMapped: false }));
    return { curtain: curtainGeometry, profile: profileLine, ticks: tickGeometry };
  }, [city, section, lift]);
  useLayoutEffect(() => () => {
    curtain.dispose(); ticks.dispose();
    profile.geometry.dispose(); (profile.material as LineBasicMaterial).dispose();
  }, [curtain, profile, ticks]);
  return (
    <group name="section">
      <mesh geometry={curtain}>
        <meshBasicMaterial vertexColors side={DoubleSide} fog={false} toneMapped={false} />
      </mesh>
      <primitive object={profile} />
      <lineSegments geometry={ticks}>
        <lineBasicMaterial color={SITE} fog={false} toneMapped={false} />
      </lineSegments>
    </group>
  );
}
