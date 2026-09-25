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
export const AP_ACC = NORMAL_ACC * 3; // autopilot may use full boost thrust
export const AP_VMAX = NORMAL_BOOST;
export const AP_KP = 0.06;
export const AP_TAU = 1.2;

/* Ship: fusion torch on hydrogen reaction mass, FTL on exotic matter, solar + battery electrics */
export const SHIP = {
  dry: 80e3, // kg without propellant
  propCap: 120e3, // kg of hydrogen reaction mass
  ve: 200e3, // exhaust velocity, m/s (specific impulse ≈ 20,400 s)
  exoticCap: 100, // kg of exotic matter for the FTL drive and hyperdrive
  battCap: 200, // kWh
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
export const JUMP_TUNNEL_TIME = 4.5;
export const TANKER_TIME = 30;
export const RESPAWN_TIME = 4;
export const MSG_TIME = 3.2;
export const HUD_INTERVAL = 0.08;

/* Galaxy */
export const GALAXY_SEED = 20260925;
export const SYSTEM_COUNT = 110;

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
