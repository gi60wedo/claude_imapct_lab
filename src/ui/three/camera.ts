export type CameraMode = 'perspective' | 'side' | 'top';
export type Vec3 = [number, number, number];

export interface CameraPreset { position: Vec3; target: Vec3; fov: number }

/** Vertical exaggeration of terrain and building bases in the side elevation. */
export const SIDE_LIFT = 3;
/** Side elevation: eye height above the site's (lifted) ground and distance back from it, metres. */
export const SIDE_EYE_M = 18;
export const SIDE_DISTANCE_M = 420;

/**
 * Framing in metres around a focus point (x east, y up, z = −north).
 * perspective: the whole Altstadt (about 1.6 × 1.2 km) from the south-west, about 50° above the
 * horizon, so the street network and the agents between the buildings stay visible. side: a near-horizontal elevation from street-level
 * height, looking along `forward` (world x, z; default due north) across the site.
 * top: straight down through a narrow lens, close to orthographic. The tiny z offset keeps
 * OrbitControls off its pole singularity.
 */
export function cameraPreset(mode: CameraMode, [x, y, z]: Vec3, forward: readonly [number, number] = [0, -1]): CameraPreset {
  switch (mode) {
    case 'side': {
      const [fx, fz] = forward;
      const eye = y + SIDE_EYE_M;
      return {
        position: [x - fx * SIDE_DISTANCE_M, eye + 3, z - fz * SIDE_DISTANCE_M],
        target: [x, eye, z], fov: 36,
      };
    }
    case 'top':
      return { position: [x, y + 2300, z + 0.5], target: [x, y, z], fov: 18 };
    default:
      return { position: [x - 520, y + 1100, z + 760], target: [x, y, z], fov: 42 };
  }
}
