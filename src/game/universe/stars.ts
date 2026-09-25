import { kelvin } from '../lib/color';
import type { Rng } from '../lib/rng';
import type { StarInfo } from '../types';

// [class, share of stars, radius range (R☉), temperature range (K)]
const CLASSES: [string, number, [number, number], [number, number]][] = [
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
