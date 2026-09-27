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
import { JUMP_DEPART_TIME, JUMP_TUNNEL_BASE, JUMP_TUNNEL_PER_LY, LY, SKY_RADIUS } from '../constants';
import { THREE } from '../lib/three';
import type { Jump } from '../types';

/** Where the transit ends: this far short of the destination star, which then fills the view. */
export const ARRIVE_LY = 0.004;

/** Transit time for a jump of `ly` light-years: longer hops take a little longer. */
export const transitTime = (ly: number) => JUMP_TUNNEL_BASE + JUMP_TUNNEL_PER_LY * ly;

/**
 * How a star system looks in the sky from `ly` light-years away: `a` (0..1) is the log-flux
 * brightness, `size` the point size in px (it keeps swelling past the brightest, so a star you fly
 * close to blooms into a disc of glare), `fade` (0..1) dims stars near SKY_RADIUS so they fade
 * in and out at the edge of the visible set instead of popping, and `k` is the intensity to scale
 * the star's colour by (see skyColor). The system sky and the hyperspace
 * view both use this, so the sky doesn't change when hyperspace begins or ends.
 */
export function skyLook(L: number, ly: number) {
  const d = Math.max(ly, 1e-4);
  const lf = Math.log10(L / (d * d));
  // a dim red dwarf at 100 ly (L/ly² ≈ 1e-6) is barely visible, a Sun at a few ly (≈ 0.1) is bright
  const a = Math.max(0, Math.min(1, (lf + 6) / 5.5));
  const size = Math.min(56, 1.5 + 6.5 * a * a + 7 * Math.max(0, lf + 0.5));
  const fade = 1 - Math.max(0, Math.min(1, (d - SKY_RADIUS * 0.85) / (SKY_RADIUS * 0.15)));
  return { a, size, fade, k: (0.14 + 1.2 * a ** 1.4) * fade };
}

/**
 * A star's point colour in the sky: its black-body hue, saturated, times intensity `k` (from
 * skyLook). Red dwarfs read orange-red, K stars pale orange, G yellow-white, F white, A and B blue-white (hues boosted, see SKY_SATURATION),
 * all at the same perceived brightness for the same flux. Values above 1 are fine: the point
 * shader (skyPoint.frag) turns the overflow into a white core, so a bright star shows a white
 * centre in a coloured halo, as stars do in photographs, rather than clipping to a flat hue.
 */
export function skyColor(color: THREE.Color, k: number, out = new THREE.Color()) {
  const m = Math.max(color.r, color.g, color.b, 1e-3);
  // true black-body hues are pale (a 5,000 K star is (1, .89, .8)) and read as grey on a few-pixel
  // point; stretch them away from white like an astrophoto's saturation boost: 3,000 K becomes
  // red-orange (1, .4, 0), 4,500 K orange (1, .7, .45), 5,800 K pale yellow, 20,000 K clear blue
  const sat = (v: number) => Math.max(0, 1 - (1 - v / m) * SKY_SATURATION);
  out.setRGB(sat(color.r), sat(color.g), sat(color.b));
  // same perceived brightness whatever the hue: scale to the luminance of white, else a red-orange
  // dwarf (luma ~0.5) would look half as bright as a white star of the same flux
  const luma = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  return out.multiplyScalar(k / Math.max(luma, 0.4));
}

/** How far skyColor stretches star hues away from white (1 = true black-body colour). */
const SKY_SATURATION = 2;

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
