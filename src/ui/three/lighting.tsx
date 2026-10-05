// Soft daylight on the massing model: a directional sun with filtered PCF shadows framed on the
// selected site, plus a hemisphere fill. Colour, intensity and sun direction ease toward the
// active slice's preset (cool dawn, neutral midday, warm afternoon). Overcast weather dims the sun
// by `sun`, so the shadows soften into the hemisphere fill.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Vector3, type DirectionalLight, type HemisphereLight } from 'three';
import type { TimeSlice } from '../../contracts';
import type { Vec3 } from './camera';
import { QUALITY, SUN, sunDirection, type Quality } from './style';

/** Sun distance from the focus and half-size of the shadow frustum, metres. */
const SUN_DISTANCE_M = 1400;
const SHADOW_HALF_M = 650;
/** Rate of the exponential ease toward a new slice's light (1/s); ~1 s to settle. */
const TINT_RATE = 3.5;

/**
 * The city is static, so the shadow map renders only when something that casts or frames shadows
 * changes: the `revision` key, or the sun while it eases to a new slice.
 */
export function Lights({ focus, slice, quality, revision, sun: sunFactor = 1 }: {
  focus: Vec3; slice: TimeSlice; quality: Quality; revision: string; sun?: number;
}) {
  const sun = useRef<DirectionalLight>(null);
  const fill = useRef<HemisphereLight>(null);
  const gl = useThree((state) => state.gl);
  const preset = SUN[slice];
  const goal = useMemo(() => ({
    direction: new Vector3(...sunDirection(preset)), color: new Color(preset.color), intensity: preset.intensity * sunFactor,
    sky: new Color(preset.sky), ground: new Color(preset.ground), hemisphere: preset.hemisphere,
  }), [preset, sunFactor]);
  const current = useRef<typeof goal | null>(null);
  const settings = QUALITY[quality];

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => { gl.shadowMap.autoUpdate = true; };
  }, [gl]);
  useEffect(() => { gl.shadowMap.needsUpdate = true; }, [gl, revision, focus]);
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    light.shadow.radius = settings.shadowRadius;
    light.shadow.map?.dispose();
    light.shadow.map = null;
    gl.shadowMap.needsUpdate = true;
  }, [gl, settings]);

  useFrame((_, delta) => {
    const light = sun.current, hemi = fill.current;
    if (!light || !hemi) return;
    if (!current.current) {
      current.current = {
        direction: goal.direction.clone(), color: goal.color.clone(), intensity: goal.intensity,
        sky: goal.sky.clone(), ground: goal.ground.clone(), hemisphere: goal.hemisphere,
      };
    }
    const c = current.current;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * TINT_RATE);
    const moving = c.direction.distanceToSquared(goal.direction) > 1e-7;
    c.direction.lerp(goal.direction, k).normalize();
    c.color.lerp(goal.color, k);
    c.sky.lerp(goal.sky, k);
    c.ground.lerp(goal.ground, k);
    c.intensity += (goal.intensity - c.intensity) * k;
    c.hemisphere += (goal.hemisphere - c.hemisphere) * k;
    light.color.copy(c.color);
    light.intensity = c.intensity;
    hemi.color.copy(c.sky);
    hemi.groundColor.copy(c.ground);
    hemi.intensity = c.hemisphere;
    light.target.position.set(...focus);
    light.position.set(focus[0] + c.direction.x * SUN_DISTANCE_M, focus[1] + c.direction.y * SUN_DISTANCE_M,
      focus[2] + c.direction.z * SUN_DISTANCE_M);
    light.target.updateMatrixWorld();
    if (moving) gl.shadowMap.needsUpdate = true;
  });

  return (
    <>
      <hemisphereLight ref={fill} args={[preset.sky, preset.ground, preset.hemisphere]} />
      <directionalLight ref={sun} color={preset.color} intensity={preset.intensity} castShadow
        shadow-bias={-0.0003} shadow-normalBias={0.5}
        shadow-camera-left={-SHADOW_HALF_M} shadow-camera-right={SHADOW_HALF_M} shadow-camera-top={SHADOW_HALF_M}
        shadow-camera-bottom={-SHADOW_HALF_M} shadow-camera-near={50} shadow-camera-far={SUN_DISTANCE_M * 2} />
    </>
  );
}
