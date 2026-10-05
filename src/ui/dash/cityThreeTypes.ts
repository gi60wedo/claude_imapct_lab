// Shared interface with the 3D agent's src/ui/three/CityThree.tsx. Type-only: the dashboard
// codes against it while that file is written in parallel.
import type { JSX } from 'react';
import type { Candidate, SimulationResult } from '../../contracts';

export type CameraMode = 'perspective' | 'side' | 'top';

export interface CityThreeProps {
  cameraMode: CameraMode; heatmap: boolean;
  selectedId: string | null;            // candidate to focus and highlight
  candidates: Candidate[];
  result: SimulationResult | null;      // trips, heat, bottlenecks, stalls for selectedId
  timeSec: number;                      // sim time, drives trip animation
  onSelect?: (id: string) => void;
}

export type CityThreeComponent = (props: CityThreeProps) => JSX.Element;
