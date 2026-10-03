/*
 * The saddle at L1 and L2 (docs/lagrange.md). Near either point the motion, seen from the frame
 * turning with the planet, is a saddle × centre: one direction grows as e^{λt} (the unstable
 * manifold: where a ship left alone drifts to), one shrinks as e^{−λt} (the stable one: the way a
 * ship drifts in to it), and the rest oscillates at ν. Which way each runs, and how fast, comes from
 * linearising the force the ship actually feels (sim/gravity.ts: the parent's pull plus the planet's,
 * tapered) about the point, not from the small-mass formulas, so it follows the planet's mass.
 *
 * With x the offset from the point in the turning frame (x toward the planet, y along its motion,
 * z up), ω the frame's rate and K = ∂(force − centripetal)/∂x the force's gradient there, the
 * in-plane motion obeys  ẍ = K x − 2ω ẑ × ẋ,  so its modes s satisfy
 *     s⁴ + (4ω² − Kxx − Kyy) s² + (Kxx Kyy − Kxy²) = 0,
 * and for a mode s the position direction is (1, (s² − Kxx) / (Kxy + 2ω s)).
 */
import { THREE } from '../lib/three';
import type { World } from '../types';
import { hillRadius, planetPullWeight } from './gravity';
import { lagrangePoints } from './lagrange';

export interface SaddleModes {
  /** The growth rate of the unstable direction (1/s), and the oscillation rate of the rest (rad/s, 0 if it isn't one). */
  lambda: number;
  nu: number;
  /** Unit position directions (system axes) of the unstable and stable manifolds in the plane, and the velocity per unit position along each (m/s per m: ±λ). */
  unstable: THREE.Vector3;
  stable: THREE.Vector3;
  /** The point's own distance from the planet (m), for scale. */
  d: number;
}

/**
 * The saddle modes of `planet`'s L1 or L2, from the planet's present state (taken as a circular
 * orbit at its instantaneous rate).
 */
export function saddleModes(planet: World, k: 1 | 2): SaddleModes {
  const par = planet.parent;
  const lp = lagrangePoints(planet)[k - 1];
  const rel = new THREE.Vector3().subVectors(lp.pos, par.pos);
  const pRel = new THREE.Vector3().subVectors(planet.pos, par.pos);
  const vP = new THREE.Vector3().subVectors(planet.vel, par.vel);
  const h = new THREE.Vector3().crossVectors(pRel, vP);
  const w = h.length() / pRel.lengthSq(); // ω, rad/s
  const ex = pRel.clone().normalize(), // toward the planet (outward from the parent)
    ez = h.clone().normalize(),
    ey = new THREE.Vector3().crossVectors(ez, ex);
  const hill = hillRadius(planet);
  const muP = par.mu,
    muC = planet.mu;
  // the force (system axes) at parent-relative position s, planet at pRel, less the centripetal term: zero at the point
  const net = (s: THREE.Vector3) => {
    const a = s.clone().multiplyScalar(-muP / s.length() ** 3);
    const dp = pRel.clone().sub(s);
    const dd = dp.length();
    a.addScaledVector(dp, (muC * planetPullWeight(dd, hill)) / (dd * dd * dd));
    return a.addScaledVector(s, w * w); // (−ω × ω × s = ω² s for s in the plane)
  };
  // the gradient K by central differences along ex, ey (in-plane is all the modes need)
  const eps = 1e-5 * hill;
  const grad = (e: THREE.Vector3) => net(rel.clone().addScaledVector(e, eps)).sub(net(rel.clone().addScaledVector(e, -eps))).divideScalar(2 * eps);
  const gx = grad(ex),
    gy = grad(ey);
  const Kxx = gx.dot(ex),
    Kyx = gx.dot(ey),
    Kxy = gy.dot(ex),
    Kyy = gy.dot(ey);
  const Kxy2 = 0.5 * (Kxy + Kyx); // (symmetric in theory)
  const b = 4 * w * w - Kxx - Kyy,
    c = Kxx * Kyy - Kxy2 * Kxy2;
  const disc = Math.sqrt(Math.max(0, b * b - 4 * c));
  const s2 = (-b + disc) / 2; // the larger root: positive at a saddle
  const lambda = Math.sqrt(Math.max(0, s2));
  const nu = Math.sqrt(Math.max(0, (b + disc) / 2));
  const dir = (s: number) => {
    const yx = (s * s - Kxx) / (Kxy2 + 2 * w * s);
    return ex.clone().addScaledVector(ey, yx).normalize();
  };
  return { lambda, nu, unstable: dir(lambda), stable: dir(-lambda), d: rel.distanceTo(pRel) };
}
