import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Gravity, Ship } from '../types';

/* Gravity uses patched conics. The pulling body is the innermost one whose sphere of influence
   contains the ship: star → planet → moon. Bodies are fixed in space, so only that body's
   gravity applies. */

export function dominantBody(cur: CurrentSystem, pos: THREE.Vector3): Body {
  let best: Body = cur.star;
  for (const b of cur.bodies) {
    if (b.kind === 'planet' && b.pos.distanceTo(pos) < b.soi) {
      best = b;
      break;
    }
  }
  if (best !== cur.star) {
    for (const m of cur.bodies) {
      if (m.kind !== 'star' && m.parent === best && m.pos.distanceTo(pos) < m.soi) {
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
  const g = body.mu / (r * r);
  vec.multiplyScalar(g / r);
  return { body, vec, g, r };
}

export type OrbitElements =
  | { escape: true; pe: number; ap?: undefined; period?: undefined; vr: number; r: number }
  | { escape: false; pe: number; ap: number; period: number; vr: number; r: number };

/** Osculating orbit around a body from the ship's current state. */
export function orbitElements(ship: Ship, b: Body): OrbitElements {
  const rv = ship.pos.clone().sub(b.pos),
    r = rv.length();
  const v = ship.vel,
    v2 = v.lengthSq();
  const eps = v2 / 2 - b.mu / r;
  const h = rv.clone().cross(v).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (b.mu * b.mu)));
  const vr = rv.dot(v) / r;
  if (eps >= 0) return { escape: true, pe: (h * h) / (b.mu * (1 + e)), vr, r };
  const a = -b.mu / (2 * eps);
  return { escape: false, pe: a * (1 - e), ap: a * (1 + e), period: 2 * Math.PI * Math.sqrt(a ** 3 / b.mu), vr, r };
}
