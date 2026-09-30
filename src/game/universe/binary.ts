/*
 * Binary stars (docs/binaries.md): most stars have a companion. A system's is drawn here, at the
 * galaxy level, from its own random stream (a system without one is exactly as it was):
 *
 *   - whether there is one, by the primary's class (the share of pairs grows with mass, roughly as
 *     observed: M 25 %, K 40 %, G 45 %, F 50 %, A/B 65 %);
 *   - its mass, a uniform share (0.1–1) of the primary's, and its star from that (stars.ts);
 *   - close (35 %: 0.03–0.4 AU, e < 0.1, the planets orbit both) or wide (20–400 AU, e < 0.4, each
 *     star its own planets). Real separations in between mostly have few planets, so none are made.
 *
 * universe/system.ts builds the pair: both stars round their barycentre.
 */
import { lr, mulberry32, rr } from '../lib/rng';
import type { THREE } from '../lib/three';
import type { Companion, StarInfo, StarSystem } from '../types';
import { starFromMass } from './stars';

const PAIR_SHARE: Record<string, number> = { M: 0.25, K: 0.4, G: 0.45, F: 0.5, A: 0.65, B: 0.65 };
const CLOSE_SHARE = 0.35;
/** A star's mass (M☉) from its luminosity, as system.ts has always worked it out. */
export const starMass = (L: number) => Math.pow(L, 1 / 3.5);
/** R☉ in AU (a close pair's stars are kept apart by at least 4 × their radii together). */
const RSUN_AU = 0.00465;

/** The companion of a system with this primary and seed, if it has one. */
export function makeCompanion(primary: StarInfo, seed: number): Companion | undefined {
  const g = mulberry32(seed ^ 0x5bd1e995);
  if (g() >= (PAIR_SHARE[primary.cls] ?? 0.4)) return undefined;
  const m1 = starMass(primary.L);
  const star = starFromMass(Math.max(0.08, rr(g, 0.1, 1) * m1));
  const close = g() < CLOSE_SHARE;
  const a = close ? Math.max(lr(g, 0.03, 0.4), 4 * (primary.R + star.R) * RSUN_AU) : lr(g, 20, 400);
  const e = close ? g() * 0.1 : g() * 0.4;
  return { star, a, e, close };
}

/** Venydes' companion: an orange K star two weeks round the Sun-like primary, close enough for double sunsets. */
export function homeCompanion(): Companion {
  return { star: starFromMass(0.73), a: 0.15, e: 0.03, close: true };
}

const lights = new WeakMap<StarSystem, { L: number; color: THREE.Color }>();
/** How a system shines from afar (one point in the sky or on the map): both stars' light, its colour by their shares. */
export function pairLight(sys: StarSystem) {
  let l = lights.get(sys);
  if (!l) {
    const c = sys.companion;
    l = c ? { L: sys.star.L + c.star.L, color: sys.star.color.clone().lerp(c.star.color, c.star.L / (sys.star.L + c.star.L)) } : { L: sys.star.L, color: sys.star.color };
    lights.set(sys, l);
  }
  return l;
}

/** "G4 V + K3 V", or the lone star's class. */
export function pairSpec(sys: StarSystem) {
  return sys.companion ? `${sys.star.spec} + ${sys.companion.star.spec}` : sys.star.spec;
}
