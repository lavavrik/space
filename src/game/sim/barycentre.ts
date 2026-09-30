/*
 * A star pair's barycentre (docs/binaries.md): both stars orbit their common centre of mass, as real
 * pairs do. It sits at the system's origin, at rest (the frame everything hangs from), where a lone
 * star sits. It's a star-kind point with no size and no light, so the frame and `parent` code treats
 * it as it treats a lone star, and it's kept out of `cur.bodies`, so nothing draws, labels or
 * collides with it.
 */
import { GRAV } from '../constants';
import type { Rng } from '../lib/rng';
import { THREE } from '../lib/three';
import type { KeplerOrbit, Star } from '../types';

export function makeBarycentre(name: string, mass: number): Star {
  return {
    kind: 'star',
    bary: true,
    name,
    radius: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    color: new THREE.Color(0, 0, 0),
    L: 0,
    typeName: 'barycentre',
    seed: 0,
    mass,
    mu: GRAV * mass,
    soi: Infinity,
    spin: 0,
    axis: new THREE.Vector3(0, 1, 0),
    rot: 0,
  };
}

/**
 * The two stars' orbits round their barycentre, for a relative orbit of semi-major axis `a` (m) and
 * eccentricity `e`: the same ellipse scaled by the other's share of the mass, on opposite sides, at
 * the same rate. In the system's plane (y up) tilted a little, prograde, at a random phase.
 */
export function pairOrbits(a: number, e: number, m1: number, m2: number, g: Rng): [KeplerOrbit, KeplerOrbit] {
  const M = m1 + m2;
  const w = g() * 2 * Math.PI,
    tilt = (g() - 0.5) * 0.06;
  const normal = new THREE.Vector3(Math.sin(tilt), Math.cos(tilt), 0);
  const P = new THREE.Vector3(Math.cos(w), 0, Math.sin(w)).addScaledVector(normal, -Math.sin(tilt) * Math.cos(w)).normalize();
  const Q = new THREE.Vector3().crossVectors(normal, P);
  const n = Math.sqrt((GRAV * M) / a ** 3);
  const M0 = g() * 2 * Math.PI;
  return [
    { a: (a * m2) / M, e, P, Q, n, M0 },
    { a: (a * m1) / M, e, P: P.clone().negate(), Q: Q.clone().negate(), n, M0 },
  ];
}

/** The Roche lobe's radius as a share of the separation, for a star `q` times its partner's mass (Eggleton 1983). */
export function rocheLobe(q: number) {
  const q3 = Math.cbrt(q),
    q23 = q3 * q3;
  return (0.49 * q23) / (0.6 * q23 + Math.log(1 + q3));
}
