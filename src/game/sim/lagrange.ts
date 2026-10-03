/*
 * Lagrange points (docs/lagrange.md). Gravity here is patched conics, so a point where two bodies'
 * pulls balance can't come out of the physics: instead each one is a place on rails, worked out from
 * where the planet is now. In the frame that turns with the planet round its parent, all five sit
 * still, so each is the parent-relative position of a rigid rotation with the planet's own angular
 * velocity (ω = r × v / r²), and its velocity is ω × position.
 *
 *   L1  between the two, a Hill-radius short of the planet  r (1 − ρ)    unstable
 *   L2  beyond the planet, a Hill radius farther            r (1 + ρ)    unstable
 *   L3  opposite the planet, a hair past its orbit          −r (1 + 5q/12)   unstable (and slow to go)
 *   L4  60° ahead on the planet's orbit                     stable
 *   L5  60° behind                                          stable
 *
 * with q = m / M the mass ratio and ρ = (q / 3)^⅓. These are the small-q expansions; the planets
 * here have q ≤ 1e-3, where the error is well under 1 %. L4 and L5 are only stable when M / m
 * exceeds ~24.96 (Routh), which every planet and moon in the sim clears, but it's checked anyway.
 */
import { THREE } from '../lib/three';
import type { Body, World } from '../types';

export type LKind = 1 | 2 | 3 | 4 | 5;

export interface LPoint {
  k: LKind;
  /** "Earth L2": the planet's name and the point's number. */
  name: string;
  planet: World;
  /** System frame, m and m/s: where it is now and how it moves (it carries on round the parent). */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Whether a ship left there stays (L4, L5) or has to be flown back now and then (L1–L3). */
  stable: boolean;
  /** Station-keeping Δv, m/s per year (0 for a stable point). */
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
  const axis = h.clone().normalize();
  const q = planet.mu / par.mu;
  const rho = hillRatio(q);
  const rd = Math.sqrt(r2);
  const stable = trojansStable(q);

  const place = (k: LKind, rel: THREE.Vector3, dvOrbit: number, ok: boolean): LPoint => {
    const vel = new THREE.Vector3().crossVectors(w, rel).add(par.vel);
    return {
      k,
      name: `${planet.name} L${k}`,
      planet,
      pos: rel.add(par.pos),
      vel,
      stable: ok,
      dvYear: ok || n === 0 ? 0 : (dvOrbit * YEAR * n) / (2 * Math.PI),
    };
  };
  // station-keeping per orbit: KEEP · n · d, d the point's distance from the planet (L1, L2); for
  // L3, whose growth is slower by √q, d is the planet's distance from its parent scaled by √q
  const dHill = rho * rd;
  const dL3 = Math.sqrt(q) * rd;
  return [
    place(1, r.clone().multiplyScalar(1 - rho), KEEP * n * dHill, false),
    place(2, r.clone().multiplyScalar(1 + rho), KEEP * n * dHill, false),
    place(3, r.clone().multiplyScalar(-(1 + (5 * q) / 12)), KEEP * n * dL3, false),
    place(4, r.clone().applyAxisAngle(axis, SIXTY), 0, stable),
    place(5, r.clone().applyAxisAngle(axis, -SIXTY), 0, stable),
  ]; // index k − 1
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
