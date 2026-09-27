/*
 * Reference frames. Everything moves: worlds orbit their parents on Kepler orbits and stations
 * orbit worlds. Two frames matter to the ship:
 *
 * 1. The frame body (`Game.frameBody`): patched conics. The ship's velocity is stored relative to
 *    the body whose sphere of influence it's in (star, planet or moon), and each step the ship is
 *    carried along with that body's motion before its own velocity is applied. Inside the SOI only
 *    that body's gravity acts, so the maths is the same as before bodies moved, and everything that
 *    reads `ship.vel` as "velocity relative to the body I'm near" stays right. Crossing an SOI
 *    boundary re-expresses the velocity in the new body's frame, so nothing physically jumps.
 *
 * 2. The station frame (`Game.refFrame`): within FRAME_ENTER of a station (TARGET_FRAME_ENTER if it's
 *    your target), flight assist, the
 *    speed readout and the speed limit work relative to the station's velocity, and "all stop"
 *    means station-keeping. The ship and the station fall together, so gravity cancels out apart
 *    from tiny tidal effects.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Station } from '../types';
import { updateBodies } from './kepler';
import { updateStations } from './stations';
import { stationPointVelAt } from './stationGeom';

const tmpRide = new THREE.Vector3();

/**
 * Advance every world and station to the current sim time, carrying the ship along with its frame
 * body (it keeps its offset from the body; its own velocity is applied afterwards by the flight code).
 */
export function advanceBodies(g: Game) {
  const fb = g.frameBody;
  tmpRide.subVectors(g.ship.pos, fb.pos);
  updateBodies(g.cur.bodies, g.simTime);
  updateStations(g.cur.stations, g.simTime);
  g.ship.pos.addVectors(fb.pos, tmpRide);
}

/** Switch the frame body, re-expressing the ship's velocity so its real motion doesn't change. */
export function syncFrame(g: Game, body: Body) {
  if (body === g.frameBody) return;
  g.ship.vel.add(g.frameBody.vel).sub(body.vel);
  g.frameBody = body;
}

/** Make `body` the frame without converting the velocity (after placing the ship by hand). */
export function resetFrame(g: Game, body: Body) {
  g.frameBody = body;
}

/** Ship velocity relative to any body. */
export function velRel(g: Game, b: Body, out = new THREE.Vector3()) {
  return out.copy(g.ship.vel).add(g.frameBody.vel).sub(b.vel);
}

/** A station's velocity in the frame body's frame. */
export function stationVel(g: Game, st: Station, out = new THREE.Vector3()) {
  return out.subVectors(st.vel, g.frameBody.vel);
}

/** Enter a station's frame within this distance; leave it beyond FRAME_EXIT (hysteresis). */
export const FRAME_ENTER = 30e3; // m
export const FRAME_EXIT = 40e3;
/**
 * A targeted station is the frame from much further out. Stations round big worlds orbit faster
 * than the speed limit (Hopper Station circles a gas giant at 28 km/s, the boost limit is 15 km/s),
 * so in the planet's frame you could never catch one, and at that closing speed you'd cross the
 * 30 km FRAME_ENTER bubble in a second. From here on flight assist works relative to the station
 * instead: it bleeds off the difference (paid for in propellant) and you fly in as if it were still.
 */
export const TARGET_FRAME_ENTER = 5000e3;
export const TARGET_FRAME_EXIT = 6000e3;

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
  else {
    const t = g.target?.kind === 'station' ? g.target : null;
    const dt = t ? t.pos.distanceTo(g.ship.pos) : Infinity;
    if (t && dt < (prev === t ? TARGET_FRAME_EXIT : TARGET_FRAME_ENTER)) g.refFrame = t;
    else if (!prev || prev === t || prev.pos.distanceTo(g.ship.pos) > FRAME_EXIT) g.refFrame = stationWithin(g, FRAME_ENTER);
  }
  if (g.refFrame === prev || g.ship.mode !== 'normal') return;
  if (g.refFrame) g.showMsg(`Local frame · ${g.refFrame.name} · flight assist matches its orbit`);
  else if (prev) g.showMsg(`Left ${prev.name}'s frame`);
}

/** Velocity of the flight-assist frame relative to the frame body (zero unless near a station). */
export function frameVel(g: Game, out = new THREE.Vector3()) {
  // inside a station: its turning structure where the ship is (orbit + spin), so flight assist
  // holds you still against the hangar (sim/docking.ts)
  // (at the ship's offset from the station as of the end of the last step: mid-step the ship has
  // been carried with its frame body but not yet moved, ~150 m off at orbital speeds, which put
  // ω × r ~15 m/s wrong and kept flight assist from ever holding still)
  if (g.inStation) return stationPointVelAt(g.inStation, g.inStationRel, out).sub(g.frameBody.vel);
  return g.refFrame ? stationVel(g, g.refFrame, out) : out.copy(ZERO);
}

/** Ship velocity relative to the current frame. */
export function relVel(g: Game, out = new THREE.Vector3()) {
  return out.subVectors(g.ship.vel, frameVel(g));
}
