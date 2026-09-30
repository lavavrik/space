/*
 * Starlight at a point, in a system of one star or a pair (docs/binaries.md): which sun is the main
 * light there (the brighter: in a wide pair, a planet's own star) and how the other compares. The
 * main light is lit as a lone star always was (white, full strength: exposure and the air's scattering
 * are tuned for it); the second is tinted by its colour relative to the first's and scaled by its
 * flux relative to the first's.
 */
import { THREE } from '../lib/three';
import type { Star } from '../types';

export interface Suns {
  /** The main light. */
  s1: Star;
  /** The other, or null with one star. */
  s2: Star | null;
  /** The second's light relative to the first's: colour × strength (0 with one star). */
  c2: THREE.Color;
}

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** The suns at `p`: `stars` is `cur.stars`. */
export function sunsAt(stars: Star[], p: THREE.Vector3, out: Suns = { s1: stars[0], s2: null, c2: new THREE.Color(0, 0, 0) }): Suns {
  if (stars.length < 2) {
    out.s1 = stars[0];
    out.s2 = null;
    out.c2.setRGB(0, 0, 0);
    return out;
  }
  const [a, b] = stars;
  const fa = a.L / Math.max(a.pos.distanceToSquared(p), 1),
    fb = b.L / Math.max(b.pos.distanceToSquared(p), 1);
  const [s1, s2, k] = fa >= fb ? [a, b, fb / fa] : [b, a, fa / fb];
  out.s1 = s1;
  out.s2 = s2;
  // its colour against the main light's, each at unit luminance: a K star beside a G one is orange
  const l1 = Math.max(lum(s1.color), 1e-6),
    l2 = Math.max(lum(s2.color), 1e-6);
  out.c2.setRGB((s2.color.r / l2 / (s1.color.r / l1)) * k, (s2.color.g / l2 / (s1.color.g / l1)) * k, (s2.color.b / l2 / (s1.color.b / l1)) * k);
  return out;
}
