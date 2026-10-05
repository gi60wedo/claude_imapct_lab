// DRAFT until contract freeze

export type SiteKind = 'square' | 'pedestrian' | 'ground_floor' | 'benchmark';
export type Scenario = 'SUNNY_SAT' | 'RAINY_SAT' | 'CHRISTMAS_MARKET';
export type TimeSlice = '05:30_DELIVERY' | '11:30_PEAK' | '15:00_LULL';
export type PersonaId = 'senior' | 'vendor' | 'commuter' | 'retailer';

export interface Candidate {
  id: string; name: string; kind: SiteKind;
  polygon: [number, number][];            // [lng, lat]
  areaM2: number;
  indicators: { transitScore: number; walkScore: number; population800m: number;
                retailPoi400m: number; attractions400m: number;
                deliveryAccess: boolean; vanDistM: number };
  passedFilter: boolean; rejectReason?: string; quickRank?: number;
}

export interface Weights { accessibility: number; footfall: number; fairness: number;
                           localBusiness: number; walkability: number }   // sum = 1

export interface PersonaResult {
  score: number;            // 0–100, computed
  served: number; droppedOut: number;
  topFriction: string;      // e.g. "bollard at Königstraße 05:34"
  verdict?: string;         // first-person line written by Claude from these numbers
}

export interface Bottleneck {
  lat: number; lng: number; severity: number;   // 0–1, edge load / capacity
  type: 'BOLLARD_BLOCKAGE' | 'COBBLESTONE_FRICTION' | 'ELEVATOR_CONGESTION' | 'CROWDING';
  time: string; cause: string;
}

export interface SimulationResult {
  candidateId: string; scenario: Scenario; seed: number;
  mitigations: string[];
  criteria: Weights;                            // each 0–100
  personas: Record<PersonaId, PersonaResult>;
  bySlice: Record<TimeSlice, { heat: [number, number, number][]; bottlenecks: Bottleneck[] }>;
  stallExposure: number[];                      // visitors per stall slot → fairness
  trips: { persona: PersonaId; path: [number, number, number][] }[];   // [lng, lat, tSec]
}

export interface Brief {
  recommended: string; why: string[];
  comparisons: { site: string; betterAt: string; worseAt: string }[];
  losers: { persona: PersonaId; mitigation: string }[];
  councilBriefMd: string;
}
