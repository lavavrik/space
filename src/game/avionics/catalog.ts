/*
 * Avionics: the ship's computers. Each is a commercial unit with a maker, model number and
 * product name, and a set of capabilities that the game checks instead of hard-coding features.
 * Four fictional makers: Hesperus Avionics (orbital mechanics), Argus Optics (scanners), Meridian
 * Systems (navigation) and Wharfside Avionics (docking). The default ship carries the top model of each.
 */
import type { OrbitType } from '../types';

export type ComputerKind = 'orbit' | 'scanner' | 'nav' | 'dock';

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

/** Docking computer: flies the ship from a granted pad request to touchdown (sim/autodock.ts). */
export interface DockComputer extends UnitBase {
  kind: 'dock';
  caps: {
    approachSpeed: number; // m/s, outside the station
    insideSpeed: number; // m/s, down the slot and across the hangar
    launch: boolean; // also flies you out through the slot after launch
    clearance: boolean; // asks the station for a pad itself (engage from up to `range`)
    range: number; // m: how far out it can be engaged
  };
}

export type Computer = OrbitComputer | ScannerComputer | NavComputer | DockComputer;

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

export const DOCK_COMPUTERS: DockComputer[] = [
  { id: 'wd-100', kind: 'dock', maker: 'Wharfside Avionics', model: 'WD-100', name: 'Harbor', blurb: 'Docks for you once you have a pad (request it with K), at a careful pace', caps: { approachSpeed: 80, insideSpeed: 30, launch: false, clearance: false, range: 10e3 } },
  { id: 'wd-300', kind: 'dock', maker: 'Wharfside Avionics', model: 'WD-300', name: 'Berth', blurb: 'Engage from 50 km: flies in, requests clearance itself, docks, and flies you out after launch', caps: { approachSpeed: 150, insideSpeed: 60, launch: true, clearance: true, range: 50e3 } },
];

/** Every computer in the catalog (for looking one up by id, e.g. from a save). */
export const ALL_COMPUTERS: Computer[] = [...ORBIT_COMPUTERS, ...SCANNERS, ...NAV_COMPUTERS, ...DOCK_COMPUTERS];

/** The computers a ship has fitted, one slot per kind (null = none fitted). */
export interface Avionics {
  orbit: OrbitComputer | null;
  scanner: ScannerComputer | null;
  nav: NavComputer | null;
  dock: DockComputer | null;
}

/** The default ship: the best of each. */
export const defaultAvionics = (): Avionics => ({
  orbit: ORBIT_COMPUTERS[ORBIT_COMPUTERS.length - 1],
  scanner: SCANNERS[SCANNERS.length - 1],
  nav: NAV_COMPUTERS[NAV_COMPUTERS.length - 1],
  dock: DOCK_COMPUTERS[DOCK_COMPUTERS.length - 1],
});

/** "HX-9100 Periastron" */
export const unitLabel = (c: Computer) => `${c.model} ${c.name}`;
