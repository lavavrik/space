/*
 * Hyperspace transit. A jump is a real trip through the star field, in three phases:
 *
 *  1. charge — the drive charges and the nose swings onto the destination.
 *  2. depart — still in the system scene, the ship accelerates straight ahead with its speed
 *     growing exponentially (e-folding every ~0.16 s) from walking pace to DEPART_END_LY_S. Distance
 *     covered is speed / k, so each body drops away faster than the one before: the nearby planet
 *     shrinks over a second or two, its moons in a fraction of that, and the star last, as the
 *     ship leaves the system some ~200 AU out. Nothing just blinks out.
 *  3. tunnel — the interstellar leg: a straight line to just short of the destination star,
 *     easing in and out, so stars near the path drift past with parallax and stretch into streaks.
 *     It picks up at the departure's final speed instead of from rest, so there's no stall.
 *
 * Tunnel distances are in light-years, in the galactic frame; the departure is in metres, in the system.
 */
import { JUMP_DEPART_TIME, JUMP_TUNNEL_BASE, JUMP_TUNNEL_PER_LY, LY } from '../constants';
import { THREE } from '../lib/three';
import type { Jump } from '../types';

/** Where the transit ends: this far short of the destination star, which then fills the view. */
export const ARRIVE_LY = 0.004;

/** Transit time for a jump of `ly` light-years: longer hops take a little longer. */
export const transitTime = (ly: number) => JUMP_TUNNEL_BASE + JUMP_TUNNEL_PER_LY * ly;

/** Speed at the start of the departure, m/s. */
const DEPART_V0 = 5;
/** Speed the departure ends at and the tunnel starts from, ly/s (~600,000 c). */
export const DEPART_END_LY_S = 0.02;
/** Growth rate of the departure speed, 1/s: v = V0·e^(kt) reaches DEPART_END_LY_S at JUMP_DEPART_TIME. */
const DEPART_K = Math.log((DEPART_END_LY_S * LY) / DEPART_V0) / JUMP_DEPART_TIME;

/** Departure speed (m/s) `t` seconds into the departure phase. */
export const departSpeed = (t: number) => DEPART_V0 * Math.exp(DEPART_K * Math.min(t, JUMP_DEPART_TIME));
/** Distance covered (m) `t` seconds into the departure phase (the integral of departSpeed). */
export const departDist = (t: number) => (departSpeed(t) - DEPART_V0) / DEPART_K;

/** Smootherstep: zero speed at both ends, peak speed (1.875× average) halfway. */
const ease = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const easeRate = (u: number) => 30 * u * u * (u - 1) * (u - 1);

export interface TransitState {
  pos: THREE.Vector3; // ly, galactic
  dir: THREE.Vector3; // unit travel direction
  speed: number; // ly/s
  left: number; // ly still to go
  u: number; // 0..1 progress in time
}

/**
 * Where the tunnel's ease curve starts (0..0.3) so its opening speed matches DEPART_END_LY_S:
 * solves easeRate(u0)·path/dur ≈ v with the small-u approximation 30u².
 */
const tunnelU0 = (path: number, dur: number) => Math.min(0.3, Math.sqrt((DEPART_END_LY_S * dur) / (30 * Math.max(path, 1e-6))));

/** Where the ship is partway through the tunnel phase of a jump. */
export function transitState(j: Jump, out?: TransitState): TransitState {
  const span = j.dest.pos.clone().sub(j.from);
  const len = span.length();
  const dir = span.divideScalar(len);
  const path = Math.max(0, len - ARRIVE_LY);
  // time runs u0..1 along the ease curve; distance is renormalised so it still starts at `from`
  const u0 = tunnelU0(path, j.dur);
  const e0 = ease(u0);
  const u = u0 + (1 - u0) * Math.min(1, Math.max(0, 1 - j.t / j.dur));
  const k = path / (1 - e0);
  const done = k * (ease(u) - e0);
  const s = out ?? { pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, left: 0, u: 0 };
  s.pos.copy(j.from).addScaledVector(dir, done);
  s.dir.copy(dir);
  s.speed = (k * easeRate(u) * (1 - u0)) / j.dur;
  s.left = len - done;
  s.u = (u - u0) / (1 - u0);
  return s;
}
