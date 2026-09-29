/*
 * Outfit: optional hardware fitted into the ship's utility slots at a station (see outfit/fit.ts),
 * as opposed to the avionics computers (avionics/catalog.ts), which every ship carries. For now
 * the catalogue is thermal control from one fictional maker, Kelvin Dynamics:
 *
 *  - Deployable radiators: flat two-sided fins that fold out from the hull's flanks, in the plane
 *    of the ship's nose and top, so they're edge-on to the star both when sun-tracking (top to the
 *    star) and nose-on. They radiate from both faces at the hull's temperature (a pumped fluid loop
 *    ties them to it) and only pick up starlight on whatever face turns toward the star. Deployed,
 *    they can't take more than RADIATOR_MAX_ACC of thrust.
 *  - Heat pump: drives the radiator loop hotter than the hull, so the fins radiate far more (∝ T⁴),
 *    at half the Carnot efficiency, paid for in electrical power (which the fins also have to shed).
 *    With this ship's modest solar and battery power, it's a boost, not a miracle.
 *
 * The battery has a slot of its own: Voltaic Systems cells trade capacity against how hard they can
 * be driven (the C-rate: discharge power / capacity). Everything electrical is limited by the
 * discharge rate plus whatever the panels deliver (see sim/power.ts).
 *
 * Every module has a mass: it adds to the dry mass (so to Δv and the hull's heat capacity). The
 * stock battery's mass is part of the hull's 80 t; others count the difference.
 * Physics in sim/thermal.ts; numbers in docs/thermal.md.
 */

export type ModuleKind = 'radiator' | 'heatpump' | 'scoop' | 'deflector' | 'guard' | 'laser';

interface ModuleBase {
  id: string;
  maker: string;
  model: string;
  name: string;
  blurb: string;
  mass: number; // kg
}

export interface RadiatorModule extends ModuleBase {
  kind: 'radiator';
  caps: {
    area: number; // m² per face (it radiates from both)
    deployTime: number; // s to fold out or in
  };
}

export interface HeatPumpModule extends ModuleBase {
  kind: 'heatpump';
  caps: {
    maxKW: number; // electrical power it can draw
    lift: number; // K: how much hotter than the hull it can run the radiator loop
  };
}

/**
 * Fuel scoop: a magnetic ram intake that funnels thin gas into the tanks while you skim a gas
 * giant's upper atmosphere or a star's outer corona (normal space only: in FTL the ship isn't
 * really moving through the gas). The corona models also separate exotic matter from the solar wind.
 */
export interface ScoopModule extends ModuleBase {
  kind: 'scoop';
  caps: {
    exotic: boolean; // collects exotic matter in a corona (otherwise hydrogen only)
    rate: number; // × the baseline intake (sim/resources.ts)
  };
}

/**
 * Magnetic deflector (belt protection, sim/belt.ts): a field round the hull that turns aside the
 * charged dust of a ring's belt, cutting the erosion it causes at speed. It works (and draws power)
 * only while there's dust to deflect: in a belt, faster than DUST_V through it.
 */
export interface DeflectorModule extends ModuleBase {
  kind: 'deflector';
  caps: {
    block: number; // share of the erosion it stops (0–1)
    kw: number; // power while it works
  };
}

/**
 * Collision-warning radar (sim/belt.ts): tracks rocks ahead in a ring's belt and warns of any on a
 * collision course; the better one also nudges the ship clear (while flight assist is on and you're
 * not thrusting). It runs (and draws power) while you're in or near a belt.
 */
export interface GuardModule extends ModuleBase {
  kind: 'guard';
  caps: {
    minSize: number; // m: the smallest rock it tracks (radius)
    range: number; // m: how far ahead it looks
    avoid: boolean; // nudges you clear
    kw: number;
  };
}

/**
 * Mining laser (sim/laser.ts): aimed along the nose at a rock of a ring's belt, it boils off the
 * rock's ice; the fuel scoop catches the vapour and it's cracked into propellant. Its whole draw
 * ends up as heat in the hull, like every other load.
 */
export interface LaserModule extends ModuleBase {
  kind: 'laser';
  caps: {
    kw: number; // beam power drawn from the bus
    range: number; // m: full yield out to a third of it, none past it
  };
}

export type Module = RadiatorModule | HeatPumpModule | ScoopModule | DeflectorModule | GuardModule | LaserModule;

/** Most thrust (m/s², ~3 g) deployed radiators can take; more is capped while they're out. */
export const RADIATOR_MAX_ACC = 30;
/** Radiator surface: white ceramic coating. */
export const RADIATOR_SURFACE = { absorb: 0.15, emit: 0.9 };
/** Heat pumps reach this fraction of the Carnot coefficient of performance. */
export const PUMP_CARNOT = 0.5;

export const MODULES: Module[] = [
  {
    id: 'kr-12', kind: 'radiator', maker: 'Kelvin Dynamics', model: 'KR-12', name: 'Frostline', mass: 1800,
    blurb: '2 × 600 m² fins, 2,400 m² radiating: about doubles how fast the hull sheds heat',
    caps: { area: 1200, deployTime: 20 },
  },
  {
    id: 'kr-25', kind: 'radiator', maker: 'Kelvin Dynamics', model: 'KR-25', name: 'Glacier', mass: 3500,
    blurb: '2 × 1,250 m² fins, 5,000 m² radiating: about triples it',
    caps: { area: 2500, deployTime: 30 },
  },
  {
    id: 'fs-1', kind: 'scoop', maker: 'Aerodyne Fuel Systems', model: 'FS-1', name: 'Draught', mass: 2000,
    blurb: 'Hydrogen from gas giants and stellar coronae: 1.5–2.5 t/s. No exotic matter',
    caps: { exotic: false, rate: 1 },
  },
  {
    id: 'fs-3', kind: 'scoop', maker: 'Aerodyne Fuel Systems', model: 'FS-3', name: 'Corona', mass: 3500,
    blurb: 'Hydrogen, plus exotic matter from stellar coronae (up to 1.2 kg/s)',
    caps: { exotic: true, rate: 1 },
  },
  {
    id: 'fs-5', kind: 'scoop', maker: 'Aerodyne Fuel Systems', model: 'FS-5', name: 'Maelstrom', mass: 5500,
    blurb: 'Twice the intake of the FS-3: hydrogen and exotic matter',
    caps: { exotic: true, rate: 2 },
  },
  {
    id: 'md-4', kind: 'deflector', maker: 'Tessera Shielding', model: 'MD-4', name: 'Aegis', mass: 2500,
    blurb: 'Magnetic field against ring dust: cuts the erosion by 90 %. Draws 800 kW while it works',
    caps: { block: 0.9, kw: 800 },
  },
  {
    id: 'md-8', kind: 'deflector', maker: 'Tessera Shielding', model: 'MD-8', name: 'Bulwark', mass: 4000,
    blurb: 'A stronger field: cuts the erosion by 98 %. Draws 1.5 MW while it works',
    caps: { block: 0.98, kw: 1500 },
  },
  {
    id: 'cr-2', kind: 'guard', maker: 'Tessera Shielding', model: 'CR-2', name: 'Sentinel', mass: 600,
    blurb: 'Collision warning in ring belts: rocks of 10 m and up on a collision course, 5 km ahead',
    caps: { minSize: 10, range: 5000, avoid: false, kw: 150 },
  },
  {
    id: 'cr-5', kind: 'guard', maker: 'Tessera Shielding', model: 'CR-5', name: 'Warden', mass: 900,
    blurb: 'Tracks every rock, pebbles too (1.5 km ahead; bigger ones 8 km), and nudges you clear (with flight assist on)',
    caps: { minSize: 1.5, range: 8000, avoid: true, kw: 250 },
  },
  {
    id: 'ml-2', kind: 'laser', maker: 'Tessera Shielding', model: 'ML-2', name: 'Ablator', mass: 1500,
    blurb: 'Mining laser: boils ice off ring rocks for the fuel scoop to catch. 2 MW, out to 600 m',
    caps: { kw: 2000, range: 600 },
  },
  {
    id: 'ml-6', kind: 'laser', maker: 'Tessera Shielding', model: 'ML-6', name: 'Sunspear', mass: 3000,
    blurb: 'Mining laser: 6 MW, out to 1.5 km. Three times the ice, and three times the heat',
    caps: { kw: 6000, range: 1500 },
  },
  {
    id: 'kh-2', kind: 'heatpump', maker: 'Kelvin Dynamics', model: 'KH-2', name: 'Coldsink', mass: 1200,
    blurb: 'Runs the radiator loop up to 250 K hotter than the hull; draws up to 2 MW. Needs radiators',
    caps: { maxKW: 2000, lift: 250 },
  },
];

/** A battery: capacity, and how fast it can be discharged and charged. */
export interface BatteryModule extends ModuleBase {
  kind: 'battery';
  caps: {
    capacity: number; // kWh
    maxKW: number; // discharge limit
    chargeKW: number; // charge acceptance
  };
}

export const BATTERIES: BatteryModule[] = [
  {
    id: 'eb-200', kind: 'battery', maker: 'Voltaic Systems', model: 'EB-200', name: 'Cell', mass: 1300,
    blurb: 'Stock lithium-iron pack: 200 kWh, 5C discharge, 1C charge',
    caps: { capacity: 200, maxKW: 1000, chargeKW: 200 },
  },
  {
    id: 'eb-500', kind: 'battery', maker: 'Voltaic Systems', model: 'EB-500', name: 'Reservoir', mass: 3200,
    blurb: 'Bigger pack: 500 kWh, 5C discharge, 1C charge',
    caps: { capacity: 500, maxKW: 2500, chargeKW: 500 },
  },
  {
    id: 'hp-300', kind: 'battery', maker: 'Voltaic Systems', model: 'HP-300', name: 'Surge', mass: 3800,
    blurb: 'Titanate power cells: 300 kWh, 30C discharge (FTL charges at full rate, jumps in ~14 s), 10C charge',
    caps: { capacity: 300, maxKW: 9000, chargeKW: 3000 },
  },
  {
    id: 'hp-600', kind: 'battery', maker: 'Voltaic Systems', model: 'HP-600', name: 'Tempest', mass: 7500,
    blurb: 'Titanate plus supercapacitor bank: 600 kWh, 50C discharge (hyperjumps charge at full rate, 5 s), 10C charge',
    caps: { capacity: 600, maxKW: 30000, chargeKW: 6000 },
  },
];
export const STOCK_BATTERY = BATTERIES[0];
export const batteryById = (id: string) => BATTERIES.find((b) => b.id === id) ?? null;

export const moduleById = (id: string) => MODULES.find((m) => m.id === id) ?? null;
export const moduleLabel = (m: Module | BatteryModule) => `${m.model} ${m.name}`;

/** Utility slots on the default hull. */
export const UTILITY_SLOTS = 6;

/** What's fitted and the state of the deployable hardware. */
export interface Outfit {
  battery: BatteryModule;
  slots: (Module | null)[];
  /** 0 = stowed, 1 = fully out; moves toward `deploy` at each fitted radiator's rate. */
  radiatorsOut: number;
  deploy: boolean;
  /** Heat pump thermostat: runs while the radiators are out and the hull is above PUMP_ON_ABOVE. */
  pumpAuto: boolean;
}

/** The pump idles below this hull temperature (K): no point spending power to cool a cool ship. */
export const PUMP_ON_ABOVE = 300;

/**
 * The ship you start with: the best of everything. HP-600 Tempest battery, and in the utility
 * slots the FS-5 Maelstrom scoop, KR-25 Glacier radiators, the KH-2 Coldsink heat pump, the MD-8
 * Bulwark deflector, the CR-5 Warden collision radar and the ML-6 Sunspear mining laser.
 */
export const bestOutfit = (): Outfit => ({
  ...emptyOutfit(),
  battery: BATTERIES[BATTERIES.length - 1],
  slots: ['fs-5', 'kr-25', 'kh-2', 'md-8', 'cr-5', 'ml-6'].map((id) => moduleById(id)),
});

export const emptyOutfit = (): Outfit => ({ battery: STOCK_BATTERY, slots: Array(UTILITY_SLOTS).fill(null), radiatorsOut: 0, deploy: false, pumpAuto: true });

export const outfitMass = (o: Outfit) => o.slots.reduce((m, x) => m + (x?.mass ?? 0), 0) + o.battery.mass - STOCK_BATTERY.mass;
export const radiatorsFitted = (o: Outfit) => o.slots.filter((x): x is RadiatorModule => x?.kind === 'radiator');
export const pumpFitted = (o: Outfit) => o.slots.find((x): x is HeatPumpModule => x?.kind === 'heatpump') ?? null;
/** Radiator area per face (m²) that's out right now. */
export const radiatorArea = (o: Outfit) => radiatorsFitted(o).reduce((a, r) => a + r.caps.area, 0) * o.radiatorsOut;

/** The fitted fuel scoop with the best intake, if any (one is enough; a second adds nothing). */
export const scoopFitted = (o: Outfit) =>
  o.slots.filter((x): x is ScoopModule => x?.kind === 'scoop').sort((a, b) => Number(b.caps.exotic) - Number(a.caps.exotic) || b.caps.rate - a.caps.rate)[0] ?? null;

/** The fitted deflector and collision radar (the best of each, if more than one). */
export const deflectorFitted = (o: Outfit) => o.slots.filter((x): x is DeflectorModule => x?.kind === 'deflector').sort((a, b) => b.caps.block - a.caps.block)[0] ?? null;
export const guardFitted = (o: Outfit) => o.slots.filter((x): x is GuardModule => x?.kind === 'guard').sort((a, b) => a.caps.minSize - b.caps.minSize)[0] ?? null;
export const laserFitted = (o: Outfit) => o.slots.filter((x): x is LaserModule => x?.kind === 'laser').sort((a, b) => b.caps.kw - a.caps.kw)[0] ?? null;
