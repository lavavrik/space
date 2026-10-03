/*
 * Lagrange points (docs/lagrange.md).
 *
 *   L1  between the two, about a Hill radius short of the planet     unstable
 *   L2  beyond the planet, a Hill radius farther                      unstable
 *   L3  opposite the planet                                           free orbit
 *   L4  60° ahead                                                     free orbit, stable
 *   L5  60° behind                                                    free orbit, stable
 *
 * L1 and L2 sit still in the frame turning with the planet at its instantaneous angular rate
 * (ω = r × v / r²): velocity ω × position, acceleration −ω² × position. They are solved against the
 * same force the ship feels (sim/gravity.ts): the parent's pull plus the planet's, with the
 * planet's tapered away past HILL_FULL Hill radii. A ship put there at the point's velocity needs no
 * thrust, and the instability (a drift of e-fold ≈ 0.5 / n, ~3 weeks at Earth) is real: left alone
 * it leaves.
 *
 * L3, L4 and L5 lie 14+ Hill radii from the planet, where its pull is tapered to nothing (the force
 * there is ~q of the parent's), so each is simply a free Kepler orbit with the planet's own period:
 * the planet's orbit with its mean anomaly shifted by 180°, +60° or −60° (`trojanRel`). That is
 * exact however eccentric the planet's orbit is, and a ship there needs no thrust. In reality the
 * planet's faint pull makes L4 and L5 librate over thousands of years and L3 drift over decades;
 * neither shows in a game session. L4 and L5 are only stable when M / m exceeds ~24.96 (Routh),
 * which every planet and moon in the sim clears, but it's reported from the ratio.
 */
import { THREE } from '../lib/three';
import type { Autopilot, Body, World } from '../types';
import { hillRadius, planetPullWeight } from './gravity';
import { keplerAt, meanAnomalyOf } from './kepler';

export type LKind = 1 | 2 | 3 | 4 | 5;

export interface LPoint {
  k: LKind;
  /** "Earth L2": the planet's name and the point's number. */
  name: string;
  planet: World;
  /** System frame, m, m/s and m/s²: where it is now, how it moves, and the acceleration that keeps up with it. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  acc: THREE.Vector3;
  /** Whether a ship left there stays (L4, L5) or has to be flown back now and then (L1–L3). */
  stable: boolean;
  /** A planning estimate of real-world station-keeping, m/s per year (0 for a stable point). The sim charges what the autopilot actually burns. */
  dvYear: number;
}

/** Below this mass ratio (parent / child) L4 and L5 aren't stable (Routh's 24.96). */
export const ROUTH_RATIO = 24.96;
/** Seconds in a year (Julian). */
export const YEAR = 365.25 * 86400;
/**
 * Station-keeping per orbit as a share of n·d, d being how far the point sits from the planet (for
 * L3, its distance from the planet's orbit's scale, see below). Calibrated on JWST at the Sun–Earth
 * L2: ~3 m/s a year against n·d ≈ 300 m/s.
 */
const KEEP = 0.01;
/** An unstable collinear point's e-folding rate, in units of the planet's mean motion (small q). */
export const COLLINEAR_GROWTH = 2.07;

const SIXTY = Math.PI / 3;

/** Hill radius ratio ρ = d / a: how far L1 and L2 sit from the planet as a share of its orbit. */
export const hillRatio = (q: number) => Math.cbrt(q / 3);

/** Whether L4 and L5 of a child with mass ratio `q` (child / parent) are stable. */
export const trojansStable = (q: number) => 1 / q > ROUTH_RATIO;

/**
 * The five points of `planet`'s orbit round its parent, at the planet's present position and
 * velocity. Needs `planet.pos` and `planet.vel` current (call it after the bodies have moved).
 */
export function lagrangePoints(planet: World): LPoint[] {
  const par: Body = planet.parent;
  const r = new THREE.Vector3().subVectors(planet.pos, par.pos);
  const v = new THREE.Vector3().subVectors(planet.vel, par.vel);
  const r2 = r.lengthSq();
  const h = new THREE.Vector3().crossVectors(r, v);
  const w = h.clone().divideScalar(r2); // angular velocity vector, rad/s
  const n = w.length();
  const q = planet.mu / par.mu;
  const rho = hillRatio(q);
  const rd = Math.sqrt(r2);
  const stable = trojansStable(q);

  // L3–L5: a free orbit, the planet's own with the mean anomaly shifted (sim: nothing but the parent's pull acts there)
  const free = (k: LKind, s: { rel: THREE.Vector3; vel: THREE.Vector3 }, dvOrbit: number, ok: boolean): LPoint => {
    const d = s.rel.length();
    return {
      k,
      name: `${planet.name} L${k}`,
      planet,
      pos: s.rel.clone().add(par.pos),
      vel: s.vel.clone().add(par.vel),
      acc: s.rel.clone().multiplyScalar(-par.mu / (d * d * d)),
      stable: ok,
      dvYear: ok || n === 0 ? 0 : (dvOrbit * YEAR * n) / (2 * Math.PI),
    };
  };
  const place = (k: LKind, rel: THREE.Vector3, dvOrbit: number, ok: boolean): LPoint => {
    const vel = new THREE.Vector3().crossVectors(w, rel).add(par.vel);
    return {
      k,
      name: `${planet.name} L${k}`,
      planet,
      pos: rel.clone().add(par.pos),
      vel,
      acc: rel.clone().multiplyScalar(-n * n),
      stable: ok,
      dvYear: ok || n === 0 ? 0 : (dvOrbit * YEAR * n) / (2 * Math.PI),
    };
  };
  // station-keeping per orbit: KEEP · n · d, d the point's distance from the planet (L1, L2); for
  // L3, whose growth is slower by √q, d is √q × the planet's orbit
  const dHill = rho * rd;
  const dL3 = Math.sqrt(q) * rd;
  const hill = hillRadius(planet);
  const tro = (k: 3 | 4 | 5) => {
    const rel = new THREE.Vector3(),
      vel = new THREE.Vector3();
    trojanRel(planet, k, meanAnomalyOf(planet.orb, r), rel, vel);
    return { rel, vel };
  };
  const [x1, x2] = [collinear(par.mu, planet.mu, rd, n, hill, 1 - rho), collinear(par.mu, planet.mu, rd, n, hill, 1 + rho)];
  return [
    place(1, r.clone().multiplyScalar(x1), KEEP * n * dHill, false),
    place(2, r.clone().multiplyScalar(x2), KEEP * n * dHill, false),
    free(3, tro(3), KEEP * n * dL3, false),
    free(4, tro(4), 0, stable),
    free(5, tro(5), 0, stable),
  ]; // index k − 1
}

/** How far round its orbit, in mean anomaly, each of L3, L4 and L5 sits from the planet. */
export const TROJAN_SHIFT = { 3: Math.PI, 4: SIXTY, 5: -SIXTY } as const;

/**
 * L3, L4 or L5 relative to the parent, on the planet's own orbit with the mean anomaly shifted:
 * `M` is the planet's mean anomaly (rad; `meanAnomalyOf`, or its M0 + n·t for a future time).
 * A body there is on a free Kepler orbit with the planet's period, so it keeps its place with no
 * thrust even when the planet's orbit is eccentric.
 */
export function trojanRel(planet: World, k: 3 | 4 | 5, M: number, rel: THREE.Vector3, vel: THREE.Vector3) {
  keplerAt(planet.orb, M + TROJAN_SHIFT[k], rel, vel);
}

/**
 * The departure gate for a phasing transfer to L3, L4 or L5 (sim/phasing.ts): a free co-orbital
 * point on the planet's own orbit, ahead of it (behind it for L5) by enough that its pull is gone
 * (more than HILL_NONE Hill radii, and at least 0.15 rad). A ship there is on the planet's orbit
 * with the planet's period, so it can start phasing from an exactly known state, and the FTL leg
 * drops out matched to it the way it does beside a station.
 */
export function gatePoint(planet: World, k: 3 | 4 | 5): LPoint {
  const par = planet.parent;
  const rel0 = new THREE.Vector3().subVectors(planet.pos, par.pos);
  const q = planet.mu / par.mu;
  const ang = Math.max(0.15, 7 * hillRatio(q)) * (k === 5 ? -1 : 1);
  const rel = new THREE.Vector3(),
    vel = new THREE.Vector3();
  keplerAt(planet.orb, meanAnomalyOf(planet.orb, rel0) + ang, rel, vel);
  const d = rel.length();
  return {
    k,
    name: `${planet.name} departure point`,
    planet,
    pos: rel.clone().add(par.pos),
    vel: vel.add(par.vel),
    acc: rel.clone().multiplyScalar(-par.mu / (d * d * d)),
    stable: true,
    dvYear: 0,
  };
}

/**
 * Where on the line from the parent through the planet (as a share of the planet's orbit radius
 * `r`) a ship at rest in the turning frame feels no net force: the parent's pull, the planet's
 * (tapered like the sim's) and the centripetal term balance. Newton from the Hill-radius estimate
 * `guess`; keeps the estimate if it doesn't settle.
 */
function collinear(muP: number, muC: number, r: number, n: number, hill: number, guess: number) {
  const f = (x: number) => {
    const d = r - x; // toward the planet
    const ad = Math.abs(d);
    return -muP / (x * x) + Math.sign(d) * muC * planetPullWeight(ad, hill) / (d * d) + n * n * x;
  };
  let x = guess * r;
  for (let i = 0; i < 60; i++) {
    const h = 1e-6 * hill;
    const slope = (f(x + h) - f(x - h)) / (2 * h);
    const dx = f(x) / slope;
    if (!Number.isFinite(dx)) return guess;
    x -= dx;
    if (Math.abs(dx) < 1e-9 * r) break;
  }
  return Number.isFinite(x) && x > 0.5 * r && x < 1.5 * r ? x / r : guess;
}

/** e-folding time (s) of the drift away from an unstable point, or Infinity for a stable one. */
export function driftTime(p: LPoint): number {
  if (p.stable) return Infinity;
  const par = p.planet.parent;
  const q = p.planet.mu / par.mu;
  const n = p.planet.orb.n;
  // L1 and L2: λ ≈ 2.07 n. L3: λ ≈ n·√(21q/8), far slower
  return p.k === 3 ? 1 / (n * Math.sqrt((21 * q) / 8)) : 1 / (n * COLLINEAR_GROWTH);
}

/**
 * What a Lagrange hold is flying to now: the point itself, or while a phasing transfer is still on
 * its way to its departure gate (sim/phasing.ts), that gate.
 */
export function apPoint(ap: Autopilot): LPoint {
  const planet = ap.body as World;
  if (ap.ph?.stage === 'depart') return gatePoint(planet, ap.lk as 3 | 4 | 5);
  return lagrangePoints(planet)[ap.lk! - 1];
}
