/* Physical units */
export const AU = 1.495978707e11;
export const C = 299792458;
export const LY = 9.4607e15;
export const RSUN = 6.957e8;
export const REARTH = 6.371e6;
export const GRAV = 6.674e-11;
export const MSUN = 1.989e30;

/* View */
export const FOV = 70;

/* Drives */
export const JUMP_RANGE = 25; // ly
export const FTL_MAX = 2000 * C;

/* Normal-space flight: m/s² and m/s */
export const NORMAL_ACC = 400;
export const NORMAL_MAX = 4000;
export const NORMAL_BOOST = 15000;

/* Gravity and autopilot */
export const CRASH_SPEED = 150; // m/s: faster than this into the ground destroys the ship
/** The hull's pressure limit (Pa): 100 bar. Past it, it's crushed (sim/flight.ts collide). */
export const HULL_P_MAX = 100e5;
export const AP_ACC = NORMAL_ACC * 3; // autopilot may use full boost thrust
export const AP_TAU = 1.2;
/** The orbit autopilot takes an FTL leg when the orbit's entry point is farther than this (m). */
export const AP_FTL_MIN = 500e3;

/* Ship: fusion torch on hydrogen reaction mass, FTL on exotic matter, solar + battery electrics */
export const SHIP = {
  dry: 80e3, // kg without propellant
  propCap: 120e3, // kg of hydrogen reaction mass
  ve: 200e3, // exhaust velocity, m/s (specific impulse ≈ 20,400 s)
  exoticCap: 100, // kg of exotic matter for the FTL drive and hyperdrive
  o2Cap: 2000, // kg of liquid oxygen: life support and the fuel cell (sim/oxygen.ts)
  waterCap: 3000, // kg of water: the fuel cell's exhaust and ice, for splitting back (sim/oxygen.ts)
  solarRated: 250, // kW with panels facing a Sun-like star from 1 AU
  solarMax: 1500, // kW the power bus can take
  baseLoad: 40, // kW for life support and avionics
  kwPerAcc: 1.2, // kW of nozzle power per m/s² of thrust acceleration
  ftlCruiseKW: 600,
  ftlChargeKW: 6000,
  jumpChargeKW: 25000,
  ftlChargeKg: 0.5, // exotic matter to spin up the FTL drive
} as const;

/** kg of exotic matter per hyperjump */
export const jumpCost = (ly: number) => 2 + 0.02 * ly * ly;
/** kg/s of exotic matter while in FTL */
export const ftlBurn = (load: number) => 0.015 + 0.035 * load;

/* Timings (s) */
export const FTL_CHARGE_TIME = 3;
export const JUMP_CHARGE_TIME = 5;
// hyperspace transit lasts JUMP_TUNNEL_BASE + JUMP_TUNNEL_PER_LY × distance (see sim/hyperspace.ts)
export const JUMP_TUNNEL_BASE = 8;
/** Between the charge and hyperspace the ship accelerates out of the system for this long (s), see sim/hyperspace.ts. */
export const JUMP_DEPART_TIME = 5;
/**
 * Starlight, in multiples of what Earth gets (1361 W/m²), where things happen near a star. By flux,
 * not star radii, so a hot B star and a red dwarf are equally safe (see docs/thermal.md):
 * a hyperjump drops you where it's ARRIVE_FLUX (a Sun-like star's 0.22 AU, ~48 radii); the corona
 * scoop starts working at SCOOP_FLUX_MIN and reaches its full rate at SCOOP_FLUX_FULL (0.1 AU).
 */
export const ARRIVE_FLUX = 20;
export const SCOOP_FLUX_MIN = 25;
export const SCOOP_FLUX_FULL = 100;
/** Distance (m) from a star of luminosity L (L☉) where its flux is F (Earth units), never inside 3 radii. */
export const fluxDist = (L: number, F: number, radius: number) => Math.max(radius * 3, 1.496e11 * Math.sqrt(L / F));
export const JUMP_TUNNEL_PER_LY = 0.32;
export const TANKER_TIME = 30;
export const RESPAWN_TIME = 4;
export const MSG_TIME = 3.2;
export const HUD_INTERVAL = 0.08;

/* Galaxy: an unbounded local cluster, generated lazily in cubic sectors (see universe/galaxy.ts) */
export const GALAXY_SEED = 20260925;
export const SECTOR_SIZE = 10; // ly, edge of one generation sector
export const STARS_IN_RANGE = 100; // average number of systems within JUMP_RANGE of any point
export const STAR_DENSITY = STARS_IN_RANGE / ((4 / 3) * Math.PI * JUMP_RANGE ** 3); // systems per ly³ (≈ 0.0015)
export const SKY_RADIUS = 100; // ly: every system this close shows as a star in the sky

/* World types */
export const WT = {
  Rocky: 0,
  Desert: 1,
  EarthLike: 2,
  Ocean: 3,
  Volcanic: 4,
  Icy: 5,
  GasGiant: 6,
  IceGiant: 7,
} as const;
export const TYPES = ['Rocky body', 'Desert world', 'Earth-like world', 'Ocean world', 'Volcanic world', 'Icy body', 'Gas giant', 'Ice giant'];
export const DENSITY = [5200, 5000, 5500, 4500, 5000, 2000, 1300, 1600]; // kg/m³ by world type
export const ALBEDO = [0.12, 0.35, 0.3, 0.3, 0.1, 0.65, 0.5, 0.45];
