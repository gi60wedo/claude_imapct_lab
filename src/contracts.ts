// Shared data contract (IMPLEMENTATION_PLAN.md §5). Freeze at 13:20; additive optional fields only after that.

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
  quickScore?: number;                    // 0–100, src/rank indicator score (additive)
  evidence?: CandidateEvidence;           // how every indicator was derived (additive, Part A)
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

// ---------------------------------------------------------------------------------------------
// Part A data files in public/data (written by prep/, see prep/README.md)
// ---------------------------------------------------------------------------------------------

export type LngLat = [number, number];

export interface VanBlocker {
  restriction: string;            // e.g. "pedestrian zone", "bollard (removable) (node 123)", "against oneway"
  street: string | null;
  at: LngLat;
}

export interface CandidateEvidence {
  baseKind: Exclude<SiteKind, 'benchmark'>;
  osm: string[];                  // "way/136698909"
  centroid: LngLat;
  builtAreaM2: number;            // LoD2 footprint inside the outline
  outlineAreaM2: number;
  siteNode: number;               // graph.json node index at the centre of the site (market location for B)
  accessNodes: number[];          // graph.json walk nodes on / next to the site
  nearestStop: { name: string; walkM: number } | null;
  stopsWithin300m: { name: string; walkM: number; departures: number }[];
  departures300m: number;         // Saturday departures, all modes
  subwayDepartures300m: number;
  walk: { cobbleShare: number; stepShare: number; meanGradePct: number; crossings: number; networkM: number };
  seniorShare800m: number | null; // 0–1, Zensus
  food400m: number;
  loadingPoint?: LngLat;          // nearest legal 05:30 van stop
  vanRoute?: LngLat[];            // legal route from the edge of the study area to loadingPoint
  vanRouteM?: number;
  vanToCentreM?: number | null;   // walk from loadingPoint to siteNode (open spaces only)
  blockedBy?: VanBlocker | null;  // first rule a van would break on the cheapest physical route
  vanBlockers?: VanBlocker[];
  manualExclusion?: string;       // from prep/sites.json deny list
  note?: string;
}

export interface CandidatesFile {
  meta: { sources: string[]; referenceDay: string; deliveryTime: string;
          van: { heightM: number; widthM: number; weightT: number };
          definitions: Record<string, string>;
          rank?: { thresholds: unknown; weights: unknown; shortlist: string[] } };
  candidates: Candidate[];
}

export interface GraphNode {
  lng: number; lat: number;
  z?: number;                     // DGM1 terrain height (m); absent underground
  osm: number;                    // OSM node id (negative = synthetic hub of a pedestrian square)
  barrier?: string;               // e.g. "bollard:removable", "gate"
  vanBlock?: string;              // why this node stops a van
  elevator?: true;
  entrance?: string;              // U-Bahn entrance (station name)
  entranceWheelchair?: string;
  hub?: string;                   // centre node of a pedestrian square
}

export interface GraphEdge {
  a: number; b: number;           // node indices; oneway edges point in their legal direction
  len: number;                    // metres
  foot: boolean;                  // walkable
  vehicleAllowed: boolean;        // legal for the 3.5 t van at Saturday 05:30, incl. barriers and dimensions
  slope: number;                  // mean absolute grade (0.06 = 6 %)
  rise: number;                   // z(b) − z(a), metres
  way: number; hw: string;        // OSM way id, highway=*
  oneway?: true; steps?: true; bollard?: true; cobble?: true; sheltered?: true; crossing?: true;
  slopeSuspect?: true;            // terrain artefact at a wall, slope capped at 25 %
  surface?: string; name?: string; wheelchair?: string;
  level?: 'underground' | 'bridge';
  vanRoad?: true;                 // physically drivable (legal or not)
  vanRestrictions?: string[];     // why a vanRoad edge is not vehicleAllowed
}

export interface GraphFile { meta: Record<string, string>; nodes: GraphNode[]; edges: GraphEdge[] }

export interface PopulationFile {
  source: string; note: string;
  fields: ['lng', 'lat', 'pop', 'share65', 'avgAge'];
  summary: { cells: number; population: number; seniorShare: number; suppressedCells: number };
  cells: [number, number, number, number | null, number | null][];
}

export type TransitMode = 'subway' | 'tram' | 'bus' | 'rail' | 'funicular' | 'other';

export interface Station {
  id: string; name: string; lng: number; lat: number;
  departures: Partial<Record<TransitMode, number>>; departuresTotal: number;
  lines: Partial<Record<TransitMode, string[]>>;
  arrivals: Partial<Record<TransitMode, number[]>>;   // minutes after midnight, sorted
  platforms: { id: string; lng: number; lat: number }[];
}

export interface ArrivalsFile { source: string; date: string; weekday: string; note: string; stations: Station[] }

export interface BuildingsFile {
  source: string; fields: string;
  buildings: { id: string; h: number | null; z: number | null; polygon: LngLat[] }[];
}

export interface ImageryFile {
  source: string;
  layers: { id: string; kind: 'dop20' | 'alkis'; url: string;
            bounds: [LngLat, LngLat, LngLat, LngLat] }[];   // deck.gl BitmapLayer corners: BL, TL, TR, BR
}
