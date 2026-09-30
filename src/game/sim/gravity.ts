import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Gravity, Ship } from '../types';

/* Gravity uses patched conics. The pulling body is the innermost one whose sphere of influence
   contains the ship: the system's anchor (a lone star, or a pair's barycentre) → a wide pair's star
   (within its Roche lobe) → planet → moon. Only that body's gravity applies, and the ship's velocity
   is kept relative to it while it orbits its own parent (see sim/frame.ts). A close pair's stars
   are the exception (docs/binaries.md): outside the planets' SOIs the ship feels both, summed, in
   the barycentre's frame. */

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
    return { body, vec, g: vec.length(), r };
  }
  const g = body.mu / (r * r);
  vec.multiplyScalar(g / r);
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
