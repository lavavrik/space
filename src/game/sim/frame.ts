/*
 * Local reference frame for flight assist. Planets and moons are fixed in space, so near them the
 * system frame already is their frame. Stations move (several km/s in low orbit), so within
 * FRAME_ENTER of one, flight assist, the speed readout and the speed limit all work relative to
 * the station's velocity instead, and "all stop" means station-keeping. The ship and the station
 * fall together, so inside a station's frame gravity cancels out apart from tiny tidal effects.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Station } from '../types';

/** Enter a station's frame within this distance; leave it beyond FRAME_EXIT (hysteresis). */
export const FRAME_ENTER = 30e3; // m
export const FRAME_EXIT = 40e3;

const ZERO = new THREE.Vector3();

/** The closest station within `range` of the ship, if any. */
export function stationWithin(g: Game, range: number): Station | null {
  let best: Station | null = null,
    bestD = range;
  for (const st of g.cur.stations) {
    const d = st.pos.distanceTo(g.ship.pos);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

/** Pick the frame for this step. Call after stations have moved. */
export function updateFrame(g: Game) {
  const prev = g.refFrame;
  if (g.ship.mode !== 'normal' || g.ship.dead) g.refFrame = null;
  else if (!prev || prev.pos.distanceTo(g.ship.pos) > FRAME_EXIT) g.refFrame = stationWithin(g, FRAME_ENTER);
  if (g.refFrame === prev || g.ship.mode !== 'normal') return;
  if (g.refFrame) g.showMsg(`Local frame · ${g.refFrame.name} · flight assist matches its orbit`);
  else if (prev) g.showMsg(`Left ${prev.name}'s frame`);
}

/** Velocity of the current frame (zero for the system frame). */
export function frameVel(g: Game) {
  return g.refFrame ? g.refFrame.vel : ZERO;
}

/** Ship velocity relative to the current frame. */
export function relVel(g: Game, out = new THREE.Vector3()) {
  return out.subVectors(g.ship.vel, frameVel(g));
}
