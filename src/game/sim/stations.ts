import type { Station } from '../types';
import { keplerState } from './kepler';

/** Put a station where its orbit has it at time `t` (s). Its parent must already be at `t`. */
export function stationState(st: Station, t: number) {
  keplerState(st, t, st.parent.pos, st.parent.vel, st.pos, st.vel);
}

export function updateStations(stations: Station[], t: number) {
  for (const st of stations) stationState(st, t);
}
