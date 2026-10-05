export type CameraMode = 'perspective' | 'side' | 'top';
export type Vec3 = [number, number, number];

export interface CameraPreset { position: Vec3; target: Vec3; fov: number }

/**
 * Framing in metres around a focus point (x east, y up, z = −north).
 * perspective: oblique from the south-west. side: low from the south so terrain slope reads.
 * top: straight down through a narrow lens, close to orthographic. The tiny z offset keeps
 * OrbitControls off its pole singularity.
 */
export function cameraPreset(mode: CameraMode, [x, y, z]: Vec3): CameraPreset {
  switch (mode) {
    case 'side':
      return { position: [x + 40, y + 22, z + 430], target: [x, y + 12, z], fov: 34 };
    case 'top':
      return { position: [x, y + 2300, z + 0.5], target: [x, y, z], fov: 18 };
    default:
      return { position: [x - 250, y + 260, z + 330], target: [x, y, z], fov: 42 };
  }
}
