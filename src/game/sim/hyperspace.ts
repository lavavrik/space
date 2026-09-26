/*
 * Hyperspace transit. A jump is a real trip through the star field: the ship travels in a straight
 * line from where it was to just short of the destination star, easing in and out, so the stars
 * near the path drift past with parallax and stretch into streaks that follow the current speed.
 * Distances here are in light-years, in the galactic frame.
 */
import { JUMP_TUNNEL_BASE, JUMP_TUNNEL_PER_LY } from '../constants';
import { THREE } from '../lib/three';
import type { Jump } from '../types';

/** Where the transit ends: this far short of the destination star, which then fills the view. */
export const ARRIVE_LY = 0.004;

/** Transit time for a jump of `ly` light-years: longer hops take a little longer. */
export const transitTime = (ly: number) => JUMP_TUNNEL_BASE + JUMP_TUNNEL_PER_LY * ly;

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

/** Where the ship is partway through the tunnel phase of a jump. */
export function transitState(j: Jump, out?: TransitState): TransitState {
  const u = Math.min(1, Math.max(0, 1 - j.t / j.dur));
  const span = j.dest.pos.clone().sub(j.from);
  const len = span.length();
  const dir = span.divideScalar(len);
  const path = Math.max(0, len - ARRIVE_LY);
  const s = out ?? { pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, left: 0, u: 0 };
  s.pos.copy(j.from).addScaledVector(dir, path * ease(u));
  s.dir.copy(dir);
  s.speed = (path * easeRate(u)) / j.dur;
  s.left = len - path * ease(u);
  s.u = u;
  return s;
}
