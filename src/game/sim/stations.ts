import { THREE } from '../lib/three';
import type { Station } from '../types';
import { keplerState } from './kepler';
import { orbitBody } from './stationGeom';
import { worldQuat } from './terrain';

const qW = new THREE.Quaternion(),
  tmp = new THREE.Vector3();

/**
 * Put a station where it is at time `t` (s). Its parent must already be at `t`: an orbital station
 * from its Kepler orbit; a sky station over its spot on the ground, turning with the world
 * (worldQuat reads the world's current rotation), so its velocity is the world's plus ω × r.
 */
export function stationState(st: Station, t: number) {
  const sky = st.sky;
  if (st.depot) {
    // on a free orbit round the planet's parent (its Kepler fields are the planet's, shifted)
    const o = st.parent.parent;
    keplerState(st, t, o.pos, o.vel, st.pos, st.vel);
    return;
  }
  if (!sky) {
    keplerState(st, t, st.parent.pos, st.parent.vel, st.pos, st.vel);
    return;
  }
  const b = st.parent;
  tmp.copy(sky.dir).multiplyScalar(sky.r).applyQuaternion(worldQuat(b, qW));
  st.pos.addVectors(b.pos, tmp);
  st.vel.copy(b.axis).multiplyScalar(b.spin).cross(tmp).add(b.vel);
}

export function updateStations(stations: Station[], t: number) {
  for (const st of stations) stationState(st, t);
}

/**
 * The station's acceleration relative to its world (m/s²): the world's gravity for one in orbit (it
 * falls freely), and only the centripetal pull that keeps a sky station turning with the ground
 * (its engines hold it up against gravity). Autopilots feed this forward to stay alongside.
 */
export function stationAcc(st: Station, out = new THREE.Vector3()) {
  const b = orbitBody(st);
  const r = out.subVectors(st.pos, b.pos);
  if (!st.sky) return r.multiplyScalar(-b.mu / r.length() ** 3);
  // −ω²·(r's part across the axis)
  return r.addScaledVector(b.axis, -r.dot(b.axis)).multiplyScalar(-b.spin * b.spin);
}
