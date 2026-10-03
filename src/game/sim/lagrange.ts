/*
 * Lagrange points (docs/lagrange.md).
 *
 *   L1  between the two, about a Hill radius short of the planet     unstable
 *   L2  beyond the planet, a Hill radius farther                      unstable
 *   L3  opposite the planet                                           free orbit
 *   L4  60° ahead                                                     free orbit, stable
 *   L5  60° behind                                                    free orbit, stable
 *
 * L1 and L2 sit on the line from the parent through the planet, at a fixed share x of its distance,
 * so they move at x × its velocity: on a circular orbit that's turning with it, on an eccentric one
 * the whole line also breathes in and out (the homographic solution: exact). They are solved against the
 * same force the ship feels (sim/gravity.ts): the parent's pull plus the planet's, with the
 * planet's tapered away past HILL_FULL Hill radii. A ship put there at the point's velocity needs no
 * thrust, and the instability (a drift of e-fold 1 / (2.53 n): 23 days at Earth) is real: left alone
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
import { hillRadius, pullReach, pullWeight, tideShare, type PullReach } from './gravity';
import { keplerAt, meanAnomalyOf, railAcc } from './kepler';
import { saddleModes } from './manifold';

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
export const COLLINEAR_GROWTH = 2.53;

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
  // (the parent's own acceleration, which every point shares: zero for a star, a planet's fall round
  // its star for a moon's points. The accelerations here are absolute, like the frame's (railAcc))
  const parAcc = railAcc(par);

  // L3–L5: a free orbit, the planet's own with the mean anomaly shifted (sim: nothing but the parent's pull acts there)
  const free = (k: LKind, s: { rel: THREE.Vector3; vel: THREE.Vector3 }, dvOrbit: number, ok: boolean): LPoint => {
    const d = s.rel.length();
    return {
      k,
      name: `${planet.name} L${k}`,
      planet,
      pos: s.rel.clone().add(par.pos),
      vel: s.vel.clone().add(par.vel),
      acc: s.rel.clone().multiplyScalar(-par.mu / (d * d * d)).add(parAcc),
      stable: ok,
      dvYear: ok || n === 0 ? 0 : (dvOrbit * YEAR * n) / (2 * Math.PI),
    };
  };
  // L1 and L2: a fixed share x of the planet's position relative to the parent, so moving at x × its
  // velocity and accelerating at x × its (Kepler) acceleration. Every pull there goes as 1 / r², so
  // if x balances on the mean orbit it balances at every r: the elliptic problem's collinear points
  // are this homographic solution, exact for any eccentricity, and a ship on it needs no thrust.
  // (They used to be re-solved each step from the instantaneous r and ω, with velocity ω × position:
  // on an eccentric orbit the point slid along the line, ~40 m/s at e = 0.026, and left out the
  // planet's radial motion, so its stated velocity wasn't how it moved. The hold, steering for the
  // point's place and its velocity at once, hung for good ~100–800 m off where its 0.3/s approach
  // tail balanced the mismatch, and never settled; the tests had made the orbit circular.)
  const o = planet.orb;
  const muOrb = o.n * o.n * o.a ** 3;
  const place = (k: LKind, x: number, dvOrbit: number, ok: boolean): LPoint => {
    const rel = r.clone().multiplyScalar(x);
    return {
      k,
      name: `${planet.name} L${k}`,
      planet,
      pos: rel.clone().add(par.pos),
      vel: v.clone().multiplyScalar(x).add(par.vel),
      acc: rel.clone().multiplyScalar(-muOrb / (rd * rd * rd)).add(parAcc),
      stable: ok,
      dvYear: ok || n === 0 ? 0 : (dvOrbit * YEAR * n) / (2 * Math.PI),
    };
  };
  // station-keeping per orbit: KEEP · n · d, d the point's distance from the planet (L1, L2); for
  // L3, whose growth is slower by √q, d is √q × the planet's orbit
  const dHill = rho * rd;
  const dL3 = Math.sqrt(q) * rd;
  const hill = hillRadius(planet),
    reach = pullReach(planet);
  const tro = (k: 3 | 4 | 5) => {
    const rel = new THREE.Vector3(),
      vel = new THREE.Vector3();
    trojanRel(planet, k, meanAnomalyOf(planet.orb, r), rel, vel);
    return { rel, vel };
  };
  const [x1, x2] = [collinear(par.mu, planet.mu, o.a, o.n, hill, reach, planet.soi, 1 - rho), collinear(par.mu, planet.mu, o.a, o.n, hill, reach, planet.soi, 1 + rho)];
  return [
    place(1, x1, KEEP * n * dHill, false),
    place(2, x2, KEEP * n * dHill, false),
    free(3, tro(3), KEEP * n * dL3, false),
    free(4, tro(4), 0, stable),
    free(5, tro(5), 0, stable),
  ]; // index k − 1
}

/** Where point `k` of world `w` lies, in words ("between it and its star"; a moon's points are round its planet). */
export function lpointWhere(w: World, k: LKind) {
  const p = w.kind === 'moon' ? 'planet' : 'star';
  return { 1: `between it and its ${p}`, 2: `beyond it, away from its ${p}`, 3: `opposite it across its ${p}`, 4: 'leading it by 60°', 5: 'trailing it by 60°' }[k];
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

/** How far ahead of the world (rad of its orbit) the phasing gate sits: past its pull's reach, and at least 0.15 rad. */
export const gateLead = (w: World) => Math.max(0.15, 7 * hillRatio(w.mu / w.parent.mu));

/**
 * Whether a phasing transfer can reach point `k`: its gate has to lie short of L4 or L5 (60° off). A
 * heavy moon's pull reaches past that (about one moon in twelve: a mass ratio over ~0.006), and
 * its L4 and L5 are flown to straight, as L1 and L2 are. L3 is always far enough round.
 */
export const phasingReaches = (w: World, k: LKind) => k === 3 || (k >= 4 && gateLead(w) < SIXTY - 0.15);

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
  const ang = gateLead(planet) * (k === 5 ? -1 : 1);
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
    acc: rel.clone().multiplyScalar(-par.mu / (d * d * d)).add(railAcc(par)),
    stable: true,
    dvYear: 0,
  };
}

/**
 * Where on the line from the parent through the planet (as a share of the planet's orbit radius
 * `r`) a ship at rest in the turning frame feels no net force: the parent's pull, the planet's
 * (tapered like the sim's) and the centripetal term balance. Newton from the Hill-radius estimate
 * `guess`; keeps the estimate if it doesn't settle.
 *
 * Inside the world's SOI (`soi`; a heavy moon's L1 and L2 can lie there) the ship is in the world's
 * frame, where the parent's pull comes as a tide fading in toward the edge (sim/gravity.ts): the
 * frame carries the parent's pull on the world, and the ship feels that share (`tideShare`) of the
 * difference. A planet's points always lie outside its SOI.
 */
function collinear(muP: number, muC: number, r: number, n: number, hill: number, reach: PullReach, soi: number, guess: number) {
  const f = (x: number) => {
    const d = r - x; // toward the planet
    const ad = Math.abs(d);
    const t = ad < soi ? tideShare(ad, soi) : 1;
    return -muP * (t / (x * x) + (1 - t) / (r * r)) + Math.sign(d) * muC * pullWeight(ad, reach) / (d * d) + n * n * x;
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
  // L1 and L2: from the saddle's own growth rate (sim/manifold.ts), which follows the planet's mass.
  // L3: λ ≈ n·√(21q/8), far slower
  return p.k === 3 ? 1 / (n * Math.sqrt((21 * q) / 8)) : 1 / saddleModes(p.planet, p.k as 1 | 2).lambda;
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
