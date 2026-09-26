import { WT } from '../constants';
import { lr, mulberry32, rr, type Rng } from '../lib/rng';
import { THREE } from '../lib/three';
import { maxOrbitR, minOrbitAlt, syncRadius } from '../sim/orbits';
import { stationState } from '../sim/stations';
import type { Body, Station, StarSystem, World } from '../types';
import { HOME_ID } from './galaxy';
import { findHome } from './system';

/*
 * Orbital stations. Only some worlds get one, mostly habitable ones. Each station follows a
 * realistic Kepler orbit around its world: usually a low, near-circular orbit just above the
 * atmosphere, sometimes a high or synchronous one. Inclination is measured from the world's
 * equator, and a few stations are in polar orbits. Stations are generated from their own RNG
 * stream, so adding them didn't change any planet or moon.
 */

/** Chance that a planet of each world type (indexed by WT) has a station. Moons get half. */
const STATION_CHANCE = [0.2, 0.3, 0.9, 0.55, 0.1, 0.15, 0.4, 0.25];

const NAMES = [
  'Galileo', 'Kepler', 'Herschel', 'Tereshkova', 'Gagarin', 'Leonov', 'Armstrong', 'Ride', 'Hubble', 'Sagan',
  'Tsiolkovsky', 'Korolev', 'Oberth', 'Goddard', 'Lovelace', 'Hopper', 'Noether', 'Meitner', 'Curie', 'Halley',
  'Cassini', 'Huygens', 'Brahe', 'Copernicus', 'Lagrange', 'Laplace', 'Clarke', 'Asimov', 'Jemison', 'Chawla',
  'Hadfield', 'Aldrin', 'Glenn', 'Shepard', 'Vega', 'Leavitt', 'Rubin', 'Hawking', 'Fermi', 'Bose',
];
const KINDS = ['Station', 'Orbital', 'Port', 'Hub', 'Terminal'];

/** Station cubes are 1–1.6 km on a side, the scale of Elite Dangerous's Coriolis stations. */
const SIZE: [number, number] = [1000, 1600];

const DEG = Math.PI / 180;

/** Every station in a system, positioned for simTime 0. */
export function buildStations(sys: StarSystem, bodies: Body[]): Station[] {
  const g = mulberry32(sys.seed ^ 0x5a7e1105);
  const home = sys.id === HOME_ID ? findHome(bodies) : undefined;
  const used = new Set<string>();
  const out: Station[] = [];
  for (const b of bodies) {
    if (b.kind === 'star') continue;
    // always draw the same number of values per body, so one body's result can't shift the next
    const roll = g(),
      sg = mulberry32(Math.floor(g() * 2 ** 32));
    const chance = STATION_CHANCE[b.type] * (b.kind === 'moon' ? 0.5 : 1);
    if (b !== home && roll >= chance) continue;
    const moons = bodies.filter((m): m is World => m.kind === 'moon' && m.parent === b);
    const st = makeStation(b, moons, sg, used);
    if (st) out.push(st);
  }
  return out;
}

/** Orbit radius for a station around `b`, or null if there's no room for a stable orbit. */
function pickOrbitRadius(b: World, g: Rng, rMin: number, rMax: number) {
  if (rMax <= rMin) return null;
  const R = b.radius;
  let r: number;
  if (b.type >= WT.GasGiant) r = R * lr(g, 1.4, 5);
  else {
    const u = g();
    if (u < 0.72) r = R + lr(g, Math.max(minOrbitAlt(b) * 1.3, 250e3), Math.max(minOrbitAlt(b) * 2, 0.3 * R)); // low orbit
    else if (u < 0.88) r = syncRadius(b); // stays over one spot on the ground
    else r = R * lr(g, 2, 7); // high orbit
  }
  r = Math.min(rMax, Math.max(rMin, r));
  if (b.ring) {
    // keep clear of the rings: move outside them if there's room, else inside their inner edge
    const lo = R * b.ring.inner * 0.9,
      hi = R * b.ring.outer * 1.15;
    if (r > lo && r < hi) {
      if (hi <= rMax) r = hi;
      else if (lo >= rMin) r = lo;
      else return null;
    }
  }
  return r;
}

function makeStation(b: World, moons: World[], g: Rng, used: Set<string>): Station | null {
  const rMin = b.radius + minOrbitAlt(b) * 1.2;
  // the innermost moon of this world caps the station's orbit
  let rMax = maxOrbitR(b) * 0.6;
  for (const m of moons) rMax = Math.min(rMax, m.orbit * 0.5);
  const a = pickOrbitRadius(b, g, rMin, rMax);
  if (a === null) return null;
  // near-circular, with periapsis kept above the atmosphere
  const e = Math.min(rr(g, 0, 0.02), Math.max(0, 1 - rMin / a));

  // inclination from the equator: mostly equatorial, some mid-inclination, a few polar
  const u = g();
  const inc = (u < 0.55 ? rr(g, 0, 5) : u < 0.85 ? rr(g, 20, 65) : rr(g, 80, 100)) * DEG;
  const node = g() * 2 * Math.PI,
    argPe = g() * 2 * Math.PI;
  // equatorial basis around the world's spin axis
  const k = b.axis.clone().normalize();
  const i0 = new THREE.Vector3(1, 0, 0).cross(k);
  if (i0.lengthSq() < 1e-8) i0.set(0, 0, 1).cross(k);
  i0.normalize();
  const nodeDir = i0.applyAxisAngle(k, node);
  const normal = k.clone().applyAxisAngle(nodeDir, inc);
  const P = nodeDir.clone().applyAxisAngle(normal, argPe).normalize();
  const Q = new THREE.Vector3().crossVectors(normal, P).normalize();

  let name = '';
  for (let t = 0; t < 10 && (!name || used.has(name)); t++) name = `${NAMES[Math.floor(g() * NAMES.length)]} ${KINDS[Math.floor(g() * KINDS.length)]}`;
  used.add(name);
  const size = rr(g, SIZE[0], SIZE[1]);
  const st: Station = {
    kind: 'station',
    name,
    typeName: `Orbital station · ${b.name}`,
    parent: b,
    size,
    radius: (size * Math.sqrt(3)) / 2,
    seed: g() * 50,
    a,
    e,
    P,
    Q,
    n: Math.sqrt(b.mu / a ** 3),
    M0: g() * 2 * Math.PI,
    spinAxis: new THREE.Vector3(rr(g, -0.3, 0.3), 1, rr(g, -0.3, 0.3)).normalize(),
    spinRate: rr(g, 0.01, 0.04) * (g() < 0.5 ? -1 : 1),
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
  };
  stationState(st, 0);
  return st;
}
