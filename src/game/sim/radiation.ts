/**
 * Radiation (docs/radiation.md): the dose rate round the ship, what the hull and the magnetic
 * deflector stop of it, and the crew's accumulated dose.
 *
 * Outside, in mSv/h, from:
 *   - cosmic rays: everywhere, hard to stop (the hull takes 30 %, the deflector a little more);
 *   - each star's wind (charged, ∝ its light's flux) and its ultraviolet and X-rays (photons, steeply
 *     more for hot stars, none in a body's shadow);
 *   - a gas or ice giant's radiation belts: trapped particles round its magnetic (spin) equator,
 *     peaking ~2.5 radii out (Jupiter's: Io ~1.5 Sv/h unshielded);
 *   - the galactic core's accretion disk: hard X-rays (∝ its flux), deadly well inside the arrival point.
 * A world's air shields everything (its column over you); docked or inside a station, nothing gets in.
 *
 * Inside, the hull stops 90 % of the charged particles and 95 % of the photons, and a powered
 * deflector (outfit/catalog.ts) turns away its `block` share of the charged ones. The dose builds
 * up from that; it heals slowly (half in RECOVER_HALF), and a station's medbay clears it.
 */
import type { Game } from '../Game';
import { AU, WT } from '../constants';
import { deflectorFitted } from '../outfit/catalog';
import { THREE } from '../lib/three';
import type { Body, Star } from '../types';
import { atmoOf } from './atmosphere';
import { destroyShip } from './flight';
import { grant } from './power';

/** mSv/h outside, at 1 AU from a Sun-like star in the open (cosmic rays: ~1.8 mSv/day). */
export const COSMIC = 0.075;
/** A star's wind and particles (mSv/h per Earth's starlight flux). */
const WIND_K = 0.02;
/** A star's ultraviolet and X-rays (mSv/h per Earth's flux, for a Sun-like star; × (T/5778)⁴). */
const LIGHT_K = 0.01;
/** A Jupiter-mass giant's belts at their peak (mSv/h); ice giants' are weak. */
const BELT_K = 3000;
const MJUP = 1.898e27;
/** The galactic core's hard X-rays (mSv/h per Earth's flux of its disk's light). */
const CORE_K = 10;
/** What the hull lets through: charged particles, cosmic rays, photons. */
export const HULL_T = { charged: 0.1, cosmic: 0.7, photons: 0.05 };
/** The deflector's effect on cosmic rays, as a share of its `block` (they're too energetic to turn). */
const DEFLECT_COSMIC = 0.3;
/** It's switched on for charged radiation over this (mSv/h outside). */
const DEFLECT_MIN = 0.5;
/** Crew dose limits (Sv): elevated, radiation sickness, severe, fatal. */
export const DOSE = { warn: 0.25, sick: 1, severe: 3, fatal: 5 };
/** The dose heals by half in this long (s of sim time: 2 days). */
const RECOVER_HALF = 2 * 86400;

export type RadKind = 'cosmic' | 'charged' | 'photons';

export interface RadSource {
  name: string;
  kind: RadKind;
  rate: number; // mSv/h outside (after any air over you)
  body: Body | null;
}

/** This step's radiation, for the HUD (g.rad). */
export interface RadState {
  sources: RadSource[];
  outside: number; // mSv/h
  inside: number; // mSv/h, what the crew gets
  hullBlocked: number; // mSv/h
  deflBlocked: number; // mSv/h
  air: number; // the share the air over you lets through (1: none over you)
  shelter: string | null; // a station keeping it all out
}

/** A star's surface temperature (K) from its light and size. */
const starT = (s: Star) => 5778 * Math.pow(s.L / Math.max((s.radius / 6.957e8) ** 2, 1e-9), 0.25);

/** A giant's belts (mSv/h) at `p`: a shell round its magnetic equator, peaking ~2.5 radii out. */
function beltRate(b: Body, p: THREE.Vector3) {
  if (b.kind === 'star' || b.type < WT.GasGiant) return 0;
  const rel = p.clone().sub(b.pos);
  const x = rel.length() / b.radius;
  if (x < 1 || x > 20) return 0;
  const lat = rel.dot(b.axis) / rel.length(); // (sin of the magnetic latitude)
  const shell = Math.exp(-(((Math.log(x) - Math.log(2.5)) / 0.6) ** 2));
  const strength = Math.sqrt(b.mass / MJUP) * (b.type === WT.IceGiant ? 0.05 : 1);
  return BELT_K * strength * shell * (1 - 0.8 * lat * lat);
}

/** What the air over you lets through: e^(−8 × its column in bar). */
function airShield(g: Game) {
  let t = 1;
  for (const b of g.cur.bodies) {
    const a = atmoOf(b);
    if (!a) continue;
    const alt = g.ship.pos.distanceTo(b.pos) - b.radius;
    if (alt > a.top) continue;
    t *= Math.exp(-8 * (a.P0 / 1e5) * Math.exp(-Math.max(alt, 0) / a.H));
  }
  return t;
}

/** The radiation round the ship now, before the hull: by source (mSv/h). */
export function radiationOutside(g: Game, inTunnel: boolean): { sources: RadSource[]; air: number } {
  const sources: RadSource[] = [{ name: 'Cosmic rays', kind: 'cosmic', rate: COSMIC, body: null }];
  if (inTunnel) return { sources, air: 1 };
  const p = g.ship.pos;
  for (const s of g.power.suns) {
    const st = s.star;
    if (st.hole) {
      // (the disk's light, by its flux here: as bright as a star where you arrive)
      const flux = st.L * (AU / Math.max(p.distanceTo(st.pos), st.radius)) ** 2;
      sources.push({ name: `${st.name}'s X-rays`, kind: 'photons', rate: CORE_K * flux * s.sunlit, body: st });
      continue;
    }
    sources.push({ name: `${st.name}'s wind`, kind: 'charged', rate: WIND_K * s.flux, body: st });
    sources.push({ name: `${st.name}'s UV and X-rays`, kind: 'photons', rate: LIGHT_K * s.flux * (starT(st) / 5778) ** 4 * s.sunlit, body: st });
  }
  for (const b of g.cur.bodies) {
    const r = beltRate(b, p);
    if (r > 0.001) sources.push({ name: `${b.name}'s radiation belts`, kind: 'charged', rate: r, body: b });
  }
  const air = airShield(g);
  for (const s of sources) s.rate *= air;
  return { sources, air };
}

/**
 * Each step: the dose rate inside, the deflector's share of the power while charged radiation is
 * about, and the crew's dose (warnings at each limit, lost at the last).
 */
export function updateRadiation(g: Game, dt: number, inTunnel: boolean) {
  const { ship, power } = g;
  const { sources, air } = radiationOutside(g, inTunnel);
  const sum = (k: RadKind) => sources.reduce((t, s) => t + (s.kind === k ? s.rate : 0), 0);
  const cosmic = sum('cosmic'),
    charged = sum('charged'),
    photons = sum('photons');
  const outside = cosmic + charged + photons;
  const station = g.inStation ?? (g.dock?.docked ? g.dock.station : null);
  // the deflector: on for charged radiation (sharing its power with the ring dust's, sim/belt.ts)
  let block = 0;
  const def = deflectorFitted(ship.outfit);
  if (def && ship.breakers.shield && !station && !ship.dead) {
    if (power.shieldKW <= 0 && charged > DEFLECT_MIN) power.shieldKW = grant(g, def.caps.kw, 'deflector');
    block = def.caps.block * Math.min(1, power.shieldKW / def.caps.kw);
  }
  const hullIn = cosmic * HULL_T.cosmic + charged * HULL_T.charged + photons * HULL_T.photons;
  const inside = station ? 0 : cosmic * HULL_T.cosmic * (1 - DEFLECT_COSMIC * block) + charged * HULL_T.charged * (1 - block) + photons * HULL_T.photons;
  g.rad = { sources, outside, inside, hullBlocked: outside - hullIn, deflBlocked: station ? 0 : hullIn - inside, air, shelter: station?.name ?? null };
  if (ship.dead || dt <= 0) return;
  ship.dose = Math.max(0, ship.dose + (inside / 3.6e6) * dt - ship.dose * (1 - Math.pow(0.5, dt / RECOVER_HALF)));
  // warnings, once each, re-armed when the dose heals 10 % under the limit
  const alarm = (key: string, at: number, text: string) => {
    if (ship.dose >= at && !g.warned[key]) {
      g.warned[key] = true;
      g.showMsg(text, 'warn');
    } else if (ship.dose < at * 0.9) g.warned[key] = false;
  };
  alarm('radWarn', DOSE.warn, `Crew dose ${ship.dose.toFixed(2)} Sv · elevated · a station's medbay clears it`);
  alarm('radSick', DOSE.sick, `Crew dose ${ship.dose.toFixed(2)} Sv · radiation sickness · get out of it and to a medbay`);
  alarm('radSevere', DOSE.severe, `Crew dose ${ship.dose.toFixed(2)} Sv · severe · fatal at ${DOSE.fatal} Sv`);
  if (ship.dose >= DOSE.fatal) {
    const worst = sources.reduce((a, b) => (b.rate > a.rate ? b : a));
    destroyShip(g, `The crew died of radiation · ${worst.name.toLowerCase().startsWith('cosmic') ? 'cosmic rays' : worst.name}`, worst.body ?? g.frameBody);
  }
}

/** How long until the crew's dose is fatal at this rate (s), or null if it never will be. */
export function timeToFatal(dose: number, insideMSvH: number) {
  const perS = insideMSvH / 3.6e6;
  const heal = Math.LN2 / RECOVER_HALF;
  // (with healing, the dose settles at perS / heal: never fatal if that's under the limit)
  if (perS / heal <= DOSE.fatal) return null;
  // dose(t) = s + (d − s)·e^(−heal·t), s = perS/heal
  const s = perS / heal;
  return Math.log((s - dose) / (s - DOSE.fatal)) / heal;
}
