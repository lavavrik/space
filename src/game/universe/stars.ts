import { kelvin } from '../lib/color';
import type { Rng } from '../lib/rng';
import type { StarInfo } from '../types';

// [class, share of stars, radius range (R☉), temperature range (K)]
export const CLASSES: [string, number, [number, number], [number, number]][] = [
  ['M', 0.36, [0.12, 0.62], [2600, 3850]],
  ['K', 0.24, [0.66, 0.95], [3900, 5250]],
  ['G', 0.2, [0.88, 1.18], [5300, 6000]],
  ['F', 0.11, [1.15, 1.5], [6000, 7400]],
  ['A', 0.06, [1.5, 2.6], [7500, 10000]],
  ['B', 0.03, [2.8, 7], [10500, 26000]],
];

/** A main-sequence star. `forceG` makes it Sun-like (used for the home system). */
export function makeStar(g: Rng, forceG: boolean): StarInfo {
  let cl = CLASSES[2];
  if (!forceG) {
    let r = g();
    for (const c of CLASSES) {
      if ((r -= c[1]) <= 0) {
        cl = c;
        break;
      }
    }
  }
  const f = g();
  const T = cl[3][0] + (cl[3][1] - cl[3][0]) * f;
  const R = cl[2][0] + (cl[2][1] - cl[2][0]) * (0.25 * g() + 0.75 * f);
  const L = R * R * Math.pow(T / 5778, 4);
  const sub = Math.min(9, Math.floor(10 * (1 - f)));
  return { cls: cl[0], spec: cl[0] + sub + ' V', T, R, L, color: kelvin(T) };
}

/**
 * A main-sequence star of mass `m` (solar masses), for a pair's companion (universe/binary.ts):
 * luminosity by the mass–luminosity relation (0.23 m^2.3 below 0.43, m⁴ to 2, 1.4 m^3.5 above),
 * radius m^0.8 (m^0.57 above one), the temperature that follows, and the class and subclass by it.
 */
export function starFromMass(m: number): StarInfo {
  const L = m < 0.43 ? 0.23 * Math.pow(m, 2.3) : m < 2 ? Math.pow(m, 4) : 1.4 * Math.pow(m, 3.5);
  const R = m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
  const T = 5778 * Math.pow(L / (R * R), 0.25);
  const cl = CLASSES.find((c) => T <= c[3][1]) ?? CLASSES[CLASSES.length - 1];
  const f = Math.min(1, Math.max(0, (T - cl[3][0]) / (cl[3][1] - cl[3][0])));
  const sub = Math.min(9, Math.floor(10 * (1 - f)));
  return { cls: cl[0], spec: cl[0] + sub + ' V', T, R, L, color: kelvin(T) };
}
