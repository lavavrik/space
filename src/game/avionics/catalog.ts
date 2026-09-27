/*
 * Avionics: the ship's computers. Each is a commercial unit with a maker, model number and
 * product name, and a set of capabilities that the game checks instead of hard-coding features.
 * Three fictional makers: Hesperus Avionics (orbital mechanics), Argus Optics (scanners) and
 * Meridian Systems (navigation). The default ship carries the top model of each.
 */
import type { OrbitType } from '../types';

export type ComputerKind = 'orbit' | 'scanner' | 'nav';

interface UnitBase {
  id: string;
  maker: string;
  model: string; // e.g. HX-9100
  name: string; // e.g. Periastron
  blurb: string; // one line for the avionics panel
}

/** Approach profile for orbit insertion and holds (see sim/autopilot.ts). */
export interface ApproachProfile {
  acc: number; // m/s², braking
  radialCap: number; // m/s, climb / descent
  planeCap: number; // m/s, sideways into the orbit plane
}

export interface OrbitComputer extends UnitBase {
  kind: 'orbit';
  caps: {
    types: OrbitType[]; // orbits it can plan and fly
    preview: boolean; // orbit preview ring (L)
    ftlLeg: boolean; // takes an FTL leg to far entry points
    readouts: boolean; // deviation readouts in the autopilot status panel
    profile: ApproachProfile;
  };
}

export interface ScannerComputer extends UnitBase {
  kind: 'scanner';
  caps: {
    resolution: number; // rad: smallest angular size it can resolve
    rate: number; // scan speed multiplier (1 = baseline)
  };
}

export interface NavComputer extends UnitBase {
  kind: 'nav';
  caps: {
    crossSystem: boolean; // routes through hyperjumps
    maxHops: number; // most jumps in one route
    refuelStops: boolean; // plans refuelling stops
    optimise: boolean; // fewest jumps / least exotic / fastest
  };
}

export type Computer = OrbitComputer | ScannerComputer | NavComputer;

const ARCSEC = Math.PI / (180 * 3600);

export const ORBIT_COMPUTERS: OrbitComputer[] = [
  {
    id: 'hx-6100', kind: 'orbit', maker: 'Hesperus Avionics', model: 'HX-6100', name: 'Plumbline',
    blurb: 'Equatorial orbits and holds on thrusters; no preview',
    caps: { types: ['equatorial', 'hold'], preview: false, ftlLeg: false, readouts: false, profile: { acc: 12, radialCap: 3000, planeCap: 1500 } },
  },
  {
    id: 'hx-8200', kind: 'orbit', maker: 'Hesperus Avionics', model: 'HX-8200', name: 'Apsis',
    blurb: 'All orbit types, preview ring, FTL entry leg',
    caps: { types: ['equatorial', 'polar', 'sync', 'hold'], preview: true, ftlLeg: true, readouts: false, profile: { acc: 25, radialCap: 5000, planeCap: 3000 } },
  },
  {
    id: 'hx-9100', kind: 'orbit', maker: 'Hesperus Avionics', model: 'HX-9100', name: 'Periastron',
    blurb: 'All orbit types, preview ring, FTL entry leg, fast insertion, live deviation readouts',
    caps: { types: ['equatorial', 'polar', 'sync', 'hold'], preview: true, ftlLeg: true, readouts: true, profile: { acc: 40, radialCap: 7000, planeCap: 4000 } },
  },
];

export const SCANNERS: ScannerComputer[] = [
  { id: 'as-300', kind: 'scanner', maker: 'Argus Optics', model: 'AS-300', name: 'Glance', blurb: '60″ resolution: planets nearby, stations within a few thousand km', caps: { resolution: 60 * ARCSEC, rate: 1 } },
  { id: 'as-700', kind: 'scanner', maker: 'Argus Optics', model: 'AS-700', name: 'Watchman', blurb: '5″ resolution: planets across a few AU, stations within ~40,000 km', caps: { resolution: 5 * ARCSEC, rate: 1.5 } },
  { id: 'as-1200', kind: 'scanner', maker: 'Argus Optics', model: 'AS-1200', name: 'Panoptes', blurb: '0.2″ resolution: the whole system, stations within ~1 million km', caps: { resolution: 0.2 * ARCSEC, rate: 2.5 } },
];

export const NAV_COMPUTERS: NavComputer[] = [
  { id: 'mnv-3000', kind: 'nav', maker: 'Meridian Systems', model: 'MNV-3000', name: 'Pathfinder', blurb: 'In-system routes', caps: { crossSystem: false, maxHops: 0, refuelStops: false, optimise: false } },
  { id: 'mnv-5000', kind: 'nav', maker: 'Meridian Systems', model: 'MNV-5000', name: 'Wayfarer', blurb: 'Routes of up to 5 hyperjumps, exotic-matter aware', caps: { crossSystem: true, maxHops: 5, refuelStops: false, optimise: false } },
  { id: 'mnv-7000', kind: 'nav', maker: 'Meridian Systems', model: 'MNV-7000', name: 'Longitude', blurb: 'Unlimited hops, refuel stops, route optimisation', caps: { crossSystem: true, maxHops: Infinity, refuelStops: true, optimise: true } },
];

/** The computers a ship has fitted, one slot per kind (null = none fitted). */
export interface Avionics {
  orbit: OrbitComputer | null;
  scanner: ScannerComputer | null;
  nav: NavComputer | null;
}

/** The default ship: the best of each. */
export const defaultAvionics = (): Avionics => ({
  orbit: ORBIT_COMPUTERS[ORBIT_COMPUTERS.length - 1],
  scanner: SCANNERS[SCANNERS.length - 1],
  nav: NAV_COMPUTERS[NAV_COMPUTERS.length - 1],
});

/** "HX-9100 Periastron" */
export const unitLabel = (c: Computer) => `${c.model} ${c.name}`;
