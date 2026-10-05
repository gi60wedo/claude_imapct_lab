// Post-processing and adaptive resolution for the monochrome map. High: MSAA and soft N8AO
// ambient occlusion. Fast: SMAA instead of MSAA and no AO. No bloom and no tone curve: every
// material stays below 1, so the greys and the persona colours of the agent dots render as set.
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing';
import { MIN_DPR, QUALITY, type Quality } from './style';

export function Effects({ quality }: { quality: Quality }) {
  const settings = QUALITY[quality];
  // Keyed by quality: the composer rebuilds its passes and buffers when the tier changes.
  return settings.ambientOcclusion ? (
    <EffectComposer key="high" multisampling={settings.multisampling} stencilBuffer={false}>
      <N8AO aoRadius={6} distanceFalloff={1.2} intensity={1.6} quality="medium" halfRes color="#000000" />
      <Vignette offset={0.35} darkness={0.35} />
    </EffectComposer>
  ) : (
    <EffectComposer key="fast" multisampling={settings.multisampling} stencilBuffer={false}>
      <SMAA />
      <Vignette offset={0.35} darkness={0.35} />
    </EffectComposer>
  );
}

/**
 * Holds the frame rate by trading resolution: starts at the tier's top device pixel ratio and
 * steps down (or back up) as drei's PerformanceMonitor sees sustained low (or full) frame rates.
 */
export function AdaptiveResolution({ quality }: { quality: Quality }) {
  const setDpr = useThree((state) => state.setDpr);
  const max = Math.max(MIN_DPR, Math.min(QUALITY[quality].maxDpr, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => { setDpr(max); }, [setDpr, max]);
  return (
    <PerformanceMonitor key={quality} factor={1} step={0.2} flipflops={6}
      bounds={(refresh) => [Math.min(50, refresh * 0.8), refresh * 0.95]}
      onChange={({ factor }) => setDpr(Math.round((MIN_DPR + (max - MIN_DPR) * factor) * 20) / 20)}
      onFallback={() => setDpr(MIN_DPR)} />
  );
}
