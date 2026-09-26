import { THREE } from '../lib/three';
import type { Body, KeplerOrbit } from '../types';

/**
 * Position and velocity on a Kepler orbit at time `t` (s): solve Kepler's equation for the
 * eccentric anomaly, place the point in the orbit's perifocal frame, then add the parent's own
 * position and velocity. Exact at any t, so nothing drifts however long the game runs.
 */
export function keplerState(o: KeplerOrbit, t: number, parentPos: THREE.Vector3, parentVel: THREE.Vector3, pos: THREE.Vector3, vel: THREE.Vector3) {
  const { a, e, n, P, Q } = o;
  const M = o.M0 + n * t;
  let E = M;
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const cE = Math.cos(E),
    sE = Math.sin(E),
    s1 = Math.sqrt(1 - e * e);
  const k = (a * n) / (1 - e * cE);
  pos.copy(parentPos).addScaledVector(P, a * (cE - e)).addScaledVector(Q, a * s1 * sE);
  vel.copy(parentVel).addScaledVector(P, -sE * k).addScaledVector(Q, s1 * cE * k);
}

/**
 * The orbit (around a parent with gravitational parameter `mu`) that passes through `rel`, the
 * position relative to the parent, at t = 0 at true anomaly `nu0`, with eccentricity `e`. It moves
 * prograde (counter-clockwise seen from `up`) in the plane through `rel` closest to `up`'s equator.
 */
export function orbitThrough(rel: THREE.Vector3, mu: number, e: number, nu0: number, up = new THREE.Vector3(0, 1, 0)): KeplerOrbit {
  const r0 = rel.length();
  const u = rel.clone().divideScalar(r0);
  // orbit plane: contains the start point, tilted as little as possible from `up`'s plane
  const normal = up.clone().addScaledVector(u, -u.dot(up)).normalize();
  const along = new THREE.Vector3().crossVectors(normal, u); // direction of motion at t = 0
  // the start point sits at true anomaly nu0, so periapsis lies nu0 behind it
  const P = u.clone().multiplyScalar(Math.cos(nu0)).addScaledVector(along, -Math.sin(nu0));
  const Q = new THREE.Vector3().crossVectors(normal, P);
  const a = (r0 * (1 + e * Math.cos(nu0))) / (1 - e * e);
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  return { a, e, P, Q, n: Math.sqrt(mu / a ** 3), M0: E0 - e * Math.sin(E0) };
}

/** Move every world along its orbit to time t. Parents come before their moons in `bodies`. */
export function updateBodies(bodies: Body[], t: number) {
  for (const b of bodies) if (b.kind !== 'star') keplerState(b.orb, t, b.parent.pos, b.parent.vel, b.pos, b.vel);
}
