// Every behavioural assumption of the twin in one place, for the Method slide.
// Formulas from IMPLEMENTATION_PLAN.md §6 live in cost.ts and engine.ts; the constants below are our calibration choices.

export const TICK_SEC = 30;
export const DAY_START = 5.5 * 3600;           // 05:30, first vans
export const DAY_END = 15 * 3600;              // 15:00, market closes
export const MARKET_OPEN = 7 * 3600;

export const SLICES = {
  '05:30_DELIVERY': [5.5 * 3600, 7 * 3600],
  '11:30_PEAK': [11 * 3600, 12.5 * 3600],
  '15:00_LULL': [14.25 * 3600, 15 * 3600],
} as const;

/** Share of modeled people simulated as agents. Results are scaled back up to people. */
export const DEFAULT_SCALE = 0.25;

// Walking
export const WALK_SPEED = 1.3;                 // m/s
export const SENIOR_SPEED = 0.75;              // m/s with rollator
export const SENIOR_COBBLE_SLOWDOWN = 1.4;     // cobblestones take 40 % longer with a rollator

// Demand per Saturday (share of people in the pool who intend to visit)
export const RESIDENT_RATE = 0.02;             // of non-senior residents in the study area
export const SENIOR_RATE = 0.04;               // of residents 65+
export const POOL_RADIUS_M = 1500;             // residents farther from the Altstadt core are not modeled
export const LUNCH_SHOPPERS_PER_TRAIN = 4;     // office workers per U-Bahn arrival 11:30–13:30 with time to shop
export const TOURISTS_PER_ATTRACTION = 12;
export const PASSERS_PER_TRAIN = 3;            // non-market pedestrians per arrival, for exposure and crowding
export const PASSERS_PER_ATTRACTION = 10;

// Personas (§2, §6)
export const SENIOR_WALK_BUDGET_M = 250;       // Oma Helga walks from home only within this
export const SENIOR_TRANSIT_RADIUS_M = 200;    // a step-free stop or elevator must be this close to the market
export const SENIOR_DROP_START_M = 200;        // drop-off p = max(0, (D − 200) / 100 × 0.15)
export const SENIOR_DROP_PER_100M = 0.15;
export const SENIOR_RAIN_DROP = 0.25;          // extra drop-off for an unsheltered market in rain
export const RESIDENT_BUDGET_M = 1000;
export const TOURIST_BUDGET_M = 700;
export const COMMUTER_BREAK_MIN = 30;
export const COMMUTER_SHOP_MIN = 12;
export const COMMUTER_KIOSK_MIN = 4;
export const COMMUTER_EXIT_MIN = 2;            // platform to street
export const COMMUTER_TIE_MIN = 2;             // stations at most 2 min farther than the nearest also count
export const VENDOR_MAX_CARRY_M = 80;
export const VENDOR_CRATES = 40;
export const VENDOR_CRATES_PER_TRIP = 4;       // sack truck
export const VENDOR_CARRY_SPEED = 1.0;         // m/s
export const VENDOR_SETUP_MIN = 20;
export const VENDOR_SOFT_DEADLINE = 6.5 * 3600;   // score falls after 06:30
export const VENDOR_HARD_DEADLINE = 7 * 3600;     // unloading must finish by 07:00
export const VENDOR_DRIVE_SPEED = 4;           // m/s inside the Altstadt
export const IMPULSE_VISIT_SHARE = 0.08;       // passers within reach who drop in

// Space
export const STALL_M2 = 25;                    // stall plus aisle
export const MIN_STALLS = 10;
export const MAX_STALLS = 60;
export const ENTRY_RADIUS_M = 20;              // walk nodes this close to the site polygon are entrances
export const EXPOSURE_RADIUS_M = 60;           // passers this close count as exposed to the market
export const FRONTAGE_RADIUS_M = 200;          // shops that can gain spillover
export const BLOCKED_FRONTAGE_M = 8;           // stalls this close block a shop window
export const SHOP_PASS_RADIUS_M = 25;          // a visitor this close walks past the shop

// Crowding
export const CROWD_DENSITY_FULL = 1.0;         // persons/m² treated as severity 1
export const MIN_EDGE_AREA_M = 10;             // shortest edge length used for density
export const HEAT_CELL_M = 15;
export const ELEVATOR_CAPACITY_5MIN = 15;      // rollator users one cabin moves in 5 min

// Criteria normalisation (D normalises across sites again in score.ts)
export const FOOTFALL_REF = 6000;              // modeled exposure that maps to 63/100
export const LOCAL_BUSINESS_REF = 120;
export const WALKABILITY_ROADWORKS = 60;       // walkability points lost if a whole route ran through roadworks         // induced passes per shop that map to 63/100

// Scenarios
export const RAIN_DEMAND_OUTDOOR = 0.75;       // residents and tourists who still come to an outdoor market in rain
export const CHRISTMAS_TOURIST_FACTOR = 2;
export const CHRISTMAS_CROWD_FACTOR = 1.8;
export const SNOW_DEMAND_OUTDOOR = 0.6;         // residents and tourists who still come to an outdoor market in snow
export const SENIOR_SNOW_DROP = 0.4;            // extra senior drop-off for an outdoor market in snow
export const SNOW_SPEED = 0.8;                  // walking speed on snowy, unsheltered paths
export const RATING_SNOW_OPEN_SITE = 1.5;
export const RATING_PER_100M_SNOW = 0.35;
export const RATING_SNOW_ROUTE_MAX = 3;     // walking cost through the Christkindlesmarkt

// Interview marks out of 10 (interview.ts): start at 10, subtract what the route costs this person
export const RATING_YOUNG_PER_MIN = 0.3;
export const YOUNG_WALK_MAX_M = 1200;       // farther than this, the young commuter takes the U-Bahn
export const RATING_PER_100M_COBBLE_YOUNG = 0.3;
export const RATING_PER_STEP_RUN = 0.2;
export const RATING_PER_100M_COBBLE_SENIOR = 2.0;
export const RATING_PER_100M_ROUGH_SENIOR = 1.2;
export const RATING_PER_100M_DETOUR = 1.0;
export const RATING_PER_ROADWORK = 1.5;
export const RATING_RAIN_OPEN_SITE = 1.0;
export const RATING_PER_100M_RAIN = 0.25;
export const RATING_RAIN_ROUTE_MAX = 2.5;
