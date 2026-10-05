// Weather from the scenario: light showers on a rainy Saturday (falling streaks, wet glossy ground,
// a little haze), gentle snowfall over the Christmas market (drifting flakes, a thin snow tint on
// roofs and ground), clear skies on a sunny Saturday. The particles are one instanced quad each,
// animated entirely in the vertex shader from the instance index and the scene clock: positions
// come from a seeded hash, so every frame is a pure function of time (no Math.random). The
// precipitation fills a box around the camera target, scaled with the viewing distance so it
// reads the same from street level and from the default overview.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending, Color, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry,
  type PerspectiveCamera, ShaderMaterial, Vector2, Vector3,
} from 'three';
import type { Scenario } from '../../contracts';
import type { CityModel } from './city';
import { NOISE_GLSL } from './shaders';
import { weatherLook, type Precipitation, type Quality } from './style';

/** Rate of the exponential ease toward a new scenario's ground, roofs and particle density (1/s). */
const WEATHER_RATE = 1.6;
/** Precipitation box half-size as a share of the camera distance, clamped to these metres. */
const BOX_SHARE = 0.55;
const BOX_MIN_M = 60;
const BOX_MAX_M = 1400;

interface Controls { target: Vector3 }

const SHARED_VERTEX = /* glsl */ `
attribute float aIndex;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTime;
varying float vFade;
${NOISE_GLSL}
// World-anchored columns that wrap around the target: the precipitation stays put while the
// camera pans, and the box edges fade out.
vec2 column(float h1, float h2) {
  float box = 2.0 * uRadius;
  vec2 corner = uCenter.xz - uRadius;
  return corner + mod(vec2(h1, h2) * box - corner, box);
}
float edgeFade(vec2 xz) { return 1.0 - smoothstep(0.65, 1.0, length(xz - uCenter.xz) / uRadius); }
#include <clipping_planes_pars_vertex>
`;

// Rain: thin streaks along a slightly wind-blown fall direction, about a pixel wide at any depth.
const RAIN_VERTEX = /* glsl */ `
${SHARED_VERTEX}
uniform float uPixel;
varying float vAlong;
void main() {
  float h1 = hash11(aIndex * 1.37 + 0.5), h2 = hash11(aIndex * 2.11 + 7.3);
  float h3 = hash11(aIndex * 0.73 + 19.1), h4 = hash11(aIndex * 3.7 + 1.9);
  float height = uRadius * 0.9;
  vec2 xz = column(h1, h2);
  // A full fall in about a second and a half at any scale.
  float fall = fract(h3 - uTime * (0.55 + 0.3 * h4));
  vec3 dir = normalize(vec3(0.16, -1.0, 0.05));
  // The wind carries the drop sideways as it falls, along the streak's own slant.
  vec3 head = vec3(xz.x, uCenter.y - 0.05 * height + fall * height, xz.y) + vec3(dir.x, 0.0, dir.z) * (1.0 - fall) * height;
  float len = uRadius * 0.032 * (0.7 + 0.6 * h4);
  vec3 toEye = normalize(cameraPosition - head);
  // toEye × dir winds the quad counter-clockwise as seen from the camera, so it is never culled.
  vec3 across = normalize(cross(toEye, dir));
  float width = 1.4 * distance(cameraPosition, head) * uPixel;
  vec3 p = head - dir * position.y * len + across * position.x * width;
  vAlong = position.y;
  vFade = edgeFade(xz) * smoothstep(0.0, 0.08, fall) * (1.0 - smoothstep(0.85, 1.0, fall));
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vAlong;
varying float vFade;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float a = sin(3.14159 * vAlong) * vFade * uIntensity;
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

// Snow: soft round flakes of a few pixels, falling slowly and swaying.
const SNOW_VERTEX = /* glsl */ `
${SHARED_VERTEX}
uniform vec2 uResolution;
uniform float uPixelRatio;
varying vec2 vCorner;
void main() {
  float h1 = hash11(aIndex * 1.37 + 0.5), h2 = hash11(aIndex * 2.11 + 7.3);
  float h3 = hash11(aIndex * 0.73 + 19.1), h4 = hash11(aIndex * 3.7 + 1.9);
  float height = uRadius * 0.8;
  vec2 drift = vec2(0.012, 0.004) * uRadius * uTime;
  vec2 sway = vec2(sin(uTime * 0.7 + h1 * 6.283), cos(uTime * 0.5 + h2 * 6.283)) * uRadius * 0.012;
  vec2 xz = column(h1, h2) + sway;
  xz = uCenter.xz - uRadius + mod(xz + drift - (uCenter.xz - uRadius), 2.0 * uRadius);
  float fall = fract(h3 - uTime / (10.0 + 6.0 * h4));
  vec3 center = vec3(xz.x, uCenter.y + fall * height, xz.y);
  vCorner = position.xy;
  vFade = edgeFade(xz) * smoothstep(0.0, 0.05, fall) * (1.0 - smoothstep(0.85, 1.0, fall)) * (0.55 + 0.45 * h3);
  vec4 mvPosition = viewMatrix * vec4(center, 1.0);
  vec4 clip = projectionMatrix * mvPosition;
  clip.xy += position.xy * (2.0 + 1.8 * h4) * uPixelRatio / uResolution * clip.w;
  gl_Position = clip;
  #include <clipping_planes_vertex>
}`;

const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vCorner;
varying float vFade;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float r = dot(vCorner, vCorner);
  if (r > 1.0) discard;
  float a = (1.0 - smoothstep(0.25, 1.0, r)) * vFade * uIntensity;
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

const PARTICLE = {
  rain: { vertex: RAIN_VERTEX, fragment: RAIN_FRAGMENT, color: '#b4c6d8', intensity: 0.7,
    // Streak: x across in [-0.5, 0.5], y along in [0, 1] from the head back.
    quad: [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0] },
  snow: { vertex: SNOW_VERTEX, fragment: SNOW_FRAGMENT, color: '#f4f6fa', intensity: 0.85,
    quad: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0] },
} as const;

/** `count` particles of one kind; the index is the only per-instance input. */
function Particles({ kind, count }: { kind: Exclude<Precipitation, 'none'>; count: number }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as Controls | null;
  const gl = useThree((state) => state.gl);
  const spec = PARTICLE[kind];
  const geometry = useMemo(() => {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(spec.quad, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aIndex', new InstancedBufferAttribute(Float32Array.from({ length: count }, (_, i) => i), 1));
    g.instanceCount = count;
    return g;
  }, [spec, count]);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: spec.vertex, fragmentShader: spec.fragment,
    uniforms: {
      uCenter: { value: new Vector3() }, uRadius: { value: 400 }, uTime: { value: 0 }, uPixel: { value: 0.001 },
      uResolution: { value: new Vector2(1, 1) }, uPixelRatio: { value: 1 },
      uColor: { value: new Color(spec.color) }, uIntensity: { value: 0 },
    },
    transparent: true, depthWrite: false, blending: AdditiveBlending, clipping: true,
  }), [spec]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => () => material.dispose(), [material]);
  const fade = useRef(0);
  const buffer = useMemo(() => new Vector2(), []);
  useFrame(({ clock }, delta) => {
    const target = controls?.target;
    const u = material.uniforms;
    if (target) u.uCenter.value.copy(target);
    const distance = target ? camera.position.distanceTo(target) : 1000;
    u.uRadius.value = Math.min(BOX_MAX_M, Math.max(BOX_MIN_M, distance * BOX_SHARE));
    u.uTime.value = clock.elapsedTime;
    gl.getDrawingBufferSize(buffer);
    u.uResolution.value.copy(buffer);
    u.uPixelRatio.value = gl.getPixelRatio();
    // World metres per drawing-buffer pixel at unit distance, times the pixel ratio: CSS pixels.
    u.uPixel.value = (2 * Math.tan((camera.fov * Math.PI) / 360) / Math.max(1, buffer.y)) * gl.getPixelRatio();
    fade.current = Math.min(1, fade.current + Math.min(delta, 0.1) / 1.2);
    u.uIntensity.value = spec.intensity * fade.current;
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={40} raycast={() => null} />;
}

/**
 * Weather for a scenario: eases the city's wet and snow uniforms toward the scenario's look and
 * draws its precipitation, fewer particles on the fast tier. Resets the city to dry on unmount.
 */
export function Weather({ city, scenario, quality }: { city: CityModel; scenario: Scenario; quality: Quality }) {
  const look = weatherLook(scenario);
  const goal = useRef(look);
  goal.current = look;
  useEffect(() => () => { city.uniforms.uWet.value = 0; city.uniforms.uSnow.value = 0; }, [city]);
  useFrame((_, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * WEATHER_RATE);
    const { uWet, uSnow } = city.uniforms;
    uWet.value += (goal.current.wet - uWet.value) * k;
    uSnow.value += (goal.current.snow - uSnow.value) * k;
  });
  const count = look.particles[quality];
  if (look.precipitation === 'none' || count <= 0) return null;
  return <Particles key={`${look.precipitation}:${count}`} kind={look.precipitation} count={count} />;
}
