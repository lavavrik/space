/**
 * Eclipses: how much of the star's disc a point sees past the bodies in the way (docs/shadows.md).
 * The star is a disc of angular radius aS, a body one of aO; the covered share of the star grows
 * smoothly from first contact (separation aS + aO) to full cover (separation |aO − aS|), where it's
 * (aO / aS)², capped at 1: a moon smaller than the star's disc leaves an annulus lit. The same
 * formula runs on the GPU (gpu/shaders/shadow.wgsl eclipse), so what you see matches the panels.
 */
import { THREE } from '../lib/three';
import type { Body, Star } from '../types';

/** The share of a star (angular radius aS) covered by a disc of angular radius aO at separation sep (rad). */
export function discCover(aS: number, aO: number, sep: number) {
  const full = Math.min(1, (aO / aS) ** 2);
  const t = THREE.MathUtils.clamp((aS + aO - sep) / Math.max(aS + aO - Math.abs(aO - aS), 1e-12), 0, 1);
  return full * t * t * (3 - 2 * t);
}

const a = new THREE.Vector3(),
  b = new THREE.Vector3();

/**
 * The share of the star `star` a point `p` sees (0: total eclipse, 1: none), past `bodies` (the
 * star itself and `skip` aside). With `worst`, the body covering most of it lands there.
 */
export function sunFraction(bodies: readonly Body[], star: Star, p: THREE.Vector3, skip?: Body, worst?: { body: Body | null }) {
  const toS = a.subVectors(star.pos, p);
  const dS = toS.length();
  toS.divideScalar(dS);
  const aS = Math.asin(Math.min(1, star.radius / dS));
  let lit = 1,
    most = 0;
  if (worst) worst.body = null;
  for (const o of bodies) {
    if (o === star || o === skip) continue;
    const w = b.subVectors(o.pos, p);
    const along = w.dot(toS);
    if (along <= 0 || along > dS) continue; // behind the point, or beyond the star
    const dO = w.length();
    if (dO <= o.radius) continue; // inside it (the ground's own shading handles that)
    const aO = Math.asin(Math.min(1, o.radius / dO));
    const sep = Math.acos(THREE.MathUtils.clamp(along / dO, -1, 1));
    if (sep >= aS + aO) continue;
    const c = discCover(aS, aO, sep);
    lit *= 1 - c;
    if (worst && c > most) {
      most = c;
      worst.body = o;
    }
  }
  return lit;
}

/**
 * The bodies that can shadow part of `w` (for its surface shader): those between it and the star
 * whose shadow (with the star's penumbra) can reach it, nearest first, at most `max`.
 */
export function occludersOf(w: Body, bodies: readonly Body[], star: Star, max = 4) {
  const toS = new THREE.Vector3().subVectors(star.pos, w.pos);
  const dS = toS.length();
  toS.divideScalar(dS);
  const out: { body: Body; d: number }[] = [];
  for (const o of bodies) {
    if (o === star || o === w) continue;
    const rel = new THREE.Vector3().subVectors(o.pos, w.pos);
    const along = rel.dot(toS);
    if (along <= 0) continue;
    const perp = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
    // the penumbra widens by the star's angular diameter over the distance behind the occluder
    const spread = (star.radius / dS) * along;
    if (perp < w.radius + o.radius + spread) out.push({ body: o, d: along });
  }
  return out.sort((p, q) => p.d - q.d).slice(0, max).map((e) => e.body);
}
