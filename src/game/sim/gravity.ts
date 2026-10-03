import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Gravity, Ship, World } from '../types';

/* Gravity uses patched conics. The pulling body is the innermost one whose sphere of influence
   contains the ship: the system's anchor (a lone star, or a pair's barycentre) → a wide pair's star
   (within its Roche lobe) → planet → moon. Only that body's gravity applies, and the ship's velocity
   is kept relative to it while it orbits its own parent (see sim/frame.ts). A close pair's stars
   are the exception (docs/binaries.md): outside the planets' SOIs the ship feels both, summed, in
   the barycentre's frame.

   On top of that central pull sit the third-body perturbations (docs/lagrange.md), which are what
   make Lagrange points real instead of painted on:
     - in a star's frame, each planet's own pull, in full out to HILL_FULL Hill radii and fading to
       nothing by HILL_NONE (a radial taper, so the force stays conservative);
     - in a planet's (or moon's) frame, its parent's tidal pull (the parent's pull on the ship less
       its pull on the frame body, which is what the carried frame already supplies), fading in from
       TIDE_FROM of the way to the sphere of influence's edge.
   At the SOI boundary the two are the same acceleration, so crossing it no longer jolts the ship.
   Deep inside an SOI the tidal term is zero, so orbits there stay exact Kepler orbits. */

/** A planet's direct pull on a ship in its parent's frame: full within this many Hill radii… */
export const HILL_FULL = 3;
/** …and gone beyond this many. */
export const HILL_NONE = 6;
/** The tide starts at this share of a world's SOI radius and is full at the edge. */
export const TIDE_FROM = 0.7;

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** A world's Hill radius round its parent, m: the reach of its own gravity against the parent's tide. */
export const hillRadius = (w: World) => w.orb.a * Math.cbrt(w.mu / (3 * w.parent.mu));

/** How much of a planet's pull a ship `d` m from it feels: 1 close in, fading to 0 (see HILL_FULL). */
export const planetPullWeight = (d: number, hill: number) => 1 - smooth01((d / hill - HILL_FULL) / (HILL_NONE - HILL_FULL));

const tmpD = new THREE.Vector3(),
  tmpA = new THREE.Vector3(),
  tmpB = new THREE.Vector3(),
  tmpPert = new THREE.Vector3();

/** Acceleration toward `b` at `x` (a close pair's barycentre: both stars' pulls summed). */
function pullOf(cur: CurrentSystem, b: Body, x: THREE.Vector3, out: THREE.Vector3) {
  if (cur.close && b === cur.anchor) {
    out.set(0, 0, 0);
    for (const s of cur.stars) {
      const d = tmpD.subVectors(s.pos, x);
      const rs = d.length();
      out.addScaledVector(d, s.mu / (rs * rs * rs));
    }
    return out;
  }
  const d = out.subVectors(b.pos, x);
  const r = d.length();
  return d.multiplyScalar(b.mu / (r * r * r));
}

/**
 * The third-body acceleration on a ship at `pos` in `body`'s frame, on top of body's own pull (see
 * above). `out` is returned.
 */
export function perturbation(cur: CurrentSystem, body: Body, pos: THREE.Vector3, out: THREE.Vector3) {
  out.set(0, 0, 0);
  for (const w of cur.bodies) {
    if (w.kind !== 'planet' || w.parent !== body) continue;
    const d = tmpA.subVectors(w.pos, pos);
    const dist = d.length();
    const k = planetPullWeight(dist, hillRadius(w));
    if (k > 0) out.addScaledVector(d, (k * w.mu) / (dist * dist * dist));
  }
  if (body.kind !== 'star') {
    const f = smooth01((pos.distanceTo(body.pos) / body.soi - TIDE_FROM) / (1 - TIDE_FROM));
    if (f > 0) {
      const par = body.parent;
      out.addScaledVector(pullOf(cur, par, pos, tmpA), f).addScaledVector(pullOf(cur, par, body.pos, tmpB), -f);
    }
  }
  return out;
}

export function dominantBody(cur: CurrentSystem, pos: THREE.Vector3): Body {
  let best: Body = cur.anchor;
  if (!cur.close && cur.stars.length > 1) {
    for (const s of cur.stars) {
      if (s.pos.distanceTo(pos) < s.soi) {
        best = s;
        break;
      }
    }
  }
  for (const b of cur.bodies) {
    if (b.kind === 'planet' && b.pos.distanceTo(pos) < b.soi) {
      best = b;
      break;
    }
  }
  if (best.kind === 'planet') {
    for (const m of cur.bodies) {
      if (m.kind === 'moon' && m.parent === best && m.pos.distanceTo(pos) < m.soi) {
        best = m;
        break;
      }
    }
  }
  return best;
}

export function gravityAt(cur: CurrentSystem, pos: THREE.Vector3): Gravity {
  const body = dominantBody(cur, pos);
  const vec = body.pos.clone().sub(pos);
  const r = vec.length();
  if (cur.close && body === cur.anchor) {
    // a close pair: both stars pull
    vec.set(0, 0, 0);
    for (const s of cur.stars) {
      const d = s.pos.clone().sub(pos);
      const rs = d.length();
      vec.addScaledVector(d, s.mu / (rs * rs * rs));
    }
    vec.add(perturbation(cur, body, pos, tmpPert));
    return { body, vec, g: vec.length(), r };
  }
  const g = body.mu / (r * r);
  vec.multiplyScalar(g / r);
  vec.add(perturbation(cur, body, pos, tmpPert));
  return { body, vec, g, r };
}

export type OrbitElements =
  | { escape: true; pe: number; ap?: undefined; period?: undefined; vr: number; r: number }
  | { escape: false; pe: number; ap: number; period: number; vr: number; r: number };

/** Osculating orbit around a body from the ship's current state (ship.vel must be relative to b). */
export function orbitElements(ship: Ship, b: Body): OrbitElements {
  return orbitElementsRel(ship.pos.clone().sub(b.pos), ship.vel, b.mu);
}

/** Osculating orbit from a position and velocity relative to a body with gravitational parameter mu. */
export function orbitElementsRel(rv: THREE.Vector3, v: THREE.Vector3, mu: number): OrbitElements {
  const r = rv.length(),
    v2 = v.lengthSq();
  const eps = v2 / 2 - mu / r;
  const h = rv.clone().cross(v).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (mu * mu)));
  const vr = rv.dot(v) / r;
  if (eps >= 0) return { escape: true, pe: (h * h) / (mu * (1 + e)), vr, r };
  const a = -mu / (2 * eps);
  return { escape: false, pe: a * (1 - e), ap: a * (1 + e), period: 2 * Math.PI * Math.sqrt(a ** 3 / mu), vr, r };
}
