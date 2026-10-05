// Post-processing and adaptive resolution. High: MSAA, N8AO ambient occlusion, bloom, ACES tone
// mapping, vignette. Fast: SMAA instead of MSAA and no AO. Bloom is selective by luminance: only
// HDR materials (site outline, trips, heat, bottlenecks, the selected block's edges) exceed the
// threshold, while lit buildings and terrain stay below it.
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { MIN_DPR, QUALITY, type Quality } from './style';

/** Linear luminance above which a pixel blooms. */
export const BLOOM_THRESHOLD = 1;

export function Effects({ quality }: { quality: Quality }) {
  const settings = QUALITY[quality];
  // Keyed by quality: the composer rebuilds its passes and buffers when the tier changes.
  return settings.ambientOcclusion ? (
    <EffectComposer key="high" multisampling={settings.multisampling} stencilBuffer={false}>
      <N8AO aoRadius={7} distanceFalloff={1.4} intensity={2.4} quality="medium" halfRes color="#06101f" />
      <Bloom mipmapBlur luminanceThreshold={BLOOM_THRESHOLD} luminanceSmoothing={0.2} intensity={0.9}
        radius={0.72} levels={settings.bloomLevels} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.32} darkness={0.5} />
    </EffectComposer>
  ) : (
    <EffectComposer key="fast" multisampling={settings.multisampling} stencilBuffer={false}>
      <SMAA />
      <Bloom mipmapBlur luminanceThreshold={BLOOM_THRESHOLD} luminanceSmoothing={0.2} intensity={0.75}
        radius={0.65} levels={settings.bloomLevels} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.32} darkness={0.5} />
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
