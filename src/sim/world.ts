// Input data the twin consumes. A's prep/ writes these to public/data/*.json;
// src/sim/dev/osmWorld.ts builds the same shapes straight from datasets/ for development.

export type LngLat = [number, number];

export type Surface = 'smooth' | 'cobble' | 'rough';

export interface GraphNode {
  lng: number; lat: number;
  /** Vehicle barrier at this node. Removable bollards can be unlocked by a delivery-window mitigation. */
  barrier?: 'bollard' | 'removable_bollard' | 'gate';
  elevator?: boolean;
  /** Designated unloading destination. Vehicle access alone does not permit unloading. */
  loadingPoint?: boolean;
}

export interface GraphEdge {
  a: number; b: number;              // node indices
  lengthM: number;
  slope: number;                     // absolute grade, 0.06 = 6 %
  steps: boolean;
  surface: Surface;
  sheltered: boolean;                // arcade, covered passage, indoor
  walk: boolean;                     // pedestrians may use it
  vehicle: boolean;                  // a 3.5 t van may legally drive it at 05:30
  oneway: boolean;                   // vehicles only travel a → b
  widthM: number;                    // walkable width, for crowding capacity
  name?: string;
}

export interface SimGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface Pois {
  subwayEntrances: { lng: number; lat: number; station: string }[];
  elevators: LngLat[];
  stops: { lng: number; lat: number; name: string; mode: 'tram' | 'bus' }[];
  shops: LngLat[];
  attractions: LngLat[];
  /** Where vans enter the inner city (ring-road junctions). */
  vanEntries: LngLat[];
}

export interface PopulationCell { lng: number; lat: number; pop: number; share65: number }

/** Saturday arrivals per rail station from GTFS, seconds after midnight. */
export interface StationArrivals { name: string; lng: number; lat: number; mode: 'subway' | 'tram'; arrivals: number[] }

export interface World {
  graph: SimGraph;
  pois: Pois;
  population: PopulationCell[];
  stations: StationArrivals[];
  /** Existing unloading locations by candidate ID, supplementing tagged graph nodes.
   * An entry requires designated unloading; an absent entry allows one nearby vehicle-node fallback.
   */
  loadingPoints?: Record<string, LngLat[]>;
  /** Area the Christkindlesmarkt occupies (Hauptmarkt), blocked in CHRISTMAS_MARKET. */
  christmasMarket: LngLat[];
}

/** Interventions Claude's propose_mitigation tool can return; the engine re-simulates with them. */
export type Mitigation =
  | { kind: 'kiosk'; lng: number; lat: number; label?: string }
  | { kind: 'delivery_window'; unlockRemovableBollards: boolean; label?: string }
  | { kind: 'loading_point'; lng: number; lat: number; label?: string }
  | { kind: 'stall_layout'; layout: 'cluster' | 'loop'; label?: string };
