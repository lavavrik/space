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
 * Every module has a mass: it adds to the dry mass (so to Δv and the hull's heat capacity).
 * Physics in sim/thermal.ts; numbers in docs/thermal.md.
 */

export type ModuleKind = 'radiator' | 'heatpump';

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

export type Module = RadiatorModule | HeatPumpModule;

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
    id: 'kh-2', kind: 'heatpump', maker: 'Kelvin Dynamics', model: 'KH-2', name: 'Coldsink', mass: 1200,
    blurb: 'Runs the radiator loop up to 250 K hotter than the hull; draws up to 2 MW. Needs radiators',
    caps: { maxKW: 2000, lift: 250 },
  },
];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id) ?? null;
export const moduleLabel = (m: Module) => `${m.model} ${m.name}`;

/** Utility slots on the default hull. */
export const UTILITY_SLOTS = 2;

/** What's fitted and the state of the deployable hardware. */
export interface Outfit {
  slots: (Module | null)[];
  /** 0 = stowed, 1 = fully out; moves toward `deploy` at each fitted radiator's rate. */
  radiatorsOut: number;
  deploy: boolean;
  /** Heat pump thermostat: runs while the radiators are out and the hull is above PUMP_ON_ABOVE. */
  pumpAuto: boolean;
}

/** The pump idles below this hull temperature (K): no point spending power to cool a cool ship. */
export const PUMP_ON_ABOVE = 300;

export const emptyOutfit = (): Outfit => ({ slots: Array(UTILITY_SLOTS).fill(null), radiatorsOut: 0, deploy: false, pumpAuto: true });

export const outfitMass = (o: Outfit) => o.slots.reduce((m, x) => m + (x?.mass ?? 0), 0);
export const radiatorsFitted = (o: Outfit) => o.slots.filter((x): x is RadiatorModule => x?.kind === 'radiator');
export const pumpFitted = (o: Outfit) => o.slots.find((x): x is HeatPumpModule => x?.kind === 'heatpump') ?? null;
/** Radiator area per face (m²) that's out right now. */
export const radiatorArea = (o: Outfit) => radiatorsFitted(o).reduce((a, r) => a + r.caps.area, 0) * o.radiatorsOut;
