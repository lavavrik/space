import type { Station } from '../types';

/**
 * Put a station where its Kepler orbit has it at time `t` (s): solve Kepler's equation for the
 * eccentric anomaly, then place it in the orbit's perifocal frame around its parent. Parents are
 * fixed in space, so this is exact and needs no integration.
 */
export function stationState(st: Station, t: number) {
  const { a, e, n, P, Q } = st;
  const M = st.M0 + n * t;
  let E = M;
  for (let i = 0; i < 5; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const cE = Math.cos(E),
    sE = Math.sin(E),
    s1 = Math.sqrt(1 - e * e);
  const x = a * (cE - e),
    y = a * s1 * sE;
  const k = (a * n) / (1 - e * cE);
  st.pos.copy(st.parent.pos).addScaledVector(P, x).addScaledVector(Q, y);
  st.vel.copy(P).multiplyScalar(-sE * k).addScaledVector(Q, s1 * cE * k);
}

export function updateStations(stations: Station[], t: number) {
  for (const st of stations) stationState(st, t);
}
