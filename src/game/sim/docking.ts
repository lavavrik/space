/*
 * Docking at stations, the Elite way:
 *
 *   1. Target a station within DOCK_REQUEST_RANGE and press K: the station grants a pad.
 *   2. Fly in through the slot on the front face. The slot is on the spin axis, so it turns in
 *      place: line up and roll with it.
 *   3. Inside the station (tunnel or hangar), flight assist works against the turning structure
 *      (stationPointVel), and the ship is turned with the station so the hangar looks still
 *      ("rotation correction").
 *   4. Settle onto your pad, on the hangar's curved wall (the spin makes it "down"):
 *      - under PAD_SPEED relative to it,
 *      - top of the ship facing the axis,
 *      - within the pad.
 *      You're then docked, held on the pad, with the station's services.
 *   5. K launches you straight up off the pad.
 *
 * Hitting the hull, the tunnel or the hangar walls anywhere else bounces you off, and faster than
 * STATION_CRASH it's fatal. Geometry is in sim/stationGeom.ts.
 */
import { SHIP } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Station } from '../types';
import { destroyShip } from './flight';
import { engageAutoLaunch, engageAutodock } from './autodock';
import { HANGAR_R, PAD_COUNT, PAD_R, padLocal, stationPointVel, stationQuat, toLocal, toWorld, whereIs } from './stationGeom';

/** Within this distance (m) of a targeted station, K asks for a pad. */
export const DOCK_REQUEST_RANGE = 10e3;
/** A granted pad is withdrawn if you wander further than this (m). */
const DOCK_REVOKE_RANGE = 25e3;
/** The ship's clearance in the walls (m): its hull is ~60 × 12 m. */
const CLEARANCE = 8;
/** Touching down on the pad: at most this fast relative to it (m/s). */
const PAD_SPEED = 6;
/** How close to the wall (m) counts as on the pad. */
const PAD_HEIGHT = 12;
/** Hitting the structure faster than this (m/s) destroys the ship. */
const STATION_CRASH = 35;
/** How high the ship sits above a pad when docked (m; above CLEARANCE, so launching is clear of the wall), and how fast it launches (m/s). */
const PAD_REST = 9,
  LAUNCH_SPEED = 25;

/** Power the station supplies a docked ship (kW), in place of its panels. */
export const SHORE_POWER = 2000;

export interface Dock {
  station: Station;
  pad: number; // 0-based; shown as pad + 1
  docked: boolean;
}

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3();

/** K near a targeted station: ask for a pad, or launch if docked. Returns false if K should do something else. */
export function dockKey(g: Game) {
  const d = g.dock;
  if (d?.docked) {
    launch(g);
    return true;
  }
  const t = g.target;
  if (t?.kind !== 'station') return false;
  const dist = t.pos.distanceTo(g.ship.pos);
  // a WD-300 can be engaged from well out: it flies in and asks for clearance itself
  const unit = g.ship.avionics.dock;
  if (dist > DOCK_REQUEST_RANGE && unit?.caps.clearance && dist < unit.caps.range && g.ship.mode === 'normal' && !d) {
    engageAutodock(g, t);
    return true;
  }
  if (dist > DOCK_REQUEST_RANGE) {
    if (dist > 100e3) return false; // far off: K is the tanker again
    g.showMsg(`Request docking within ${DOCK_REQUEST_RANGE / 1000} km of ${t.name}`, 'warn');
    return true;
  }
  if (g.ship.mode !== 'normal') {
    g.showMsg('Drop out of FTL to request docking', 'warn');
    return true;
  }
  if (d?.station === t) {
    // already granted: K (again) hands over to the docking computer, if there is one
    if (g.ship.avionics.dock && !g.autodock) engageAutodock(g, t);
    else g.showMsg(`Docking already granted · ${t.name} · pad ${d.pad + 1}`);
    return true;
  }
  requestPad(g, t, `Docking granted · ${t.name} · pad`);
  // a docking computer takes it from here (the WD-100 needs the pad first: this was it)
  if (g.ship.avionics.dock) engageAutodock(g, t);
  else g.showMsg(`${g.msg.text} · enter through the slot, matching its spin`);
  return true;
}

/** The station grants a pad (random for now). `msg` gets the pad number appended. */
export function requestPad(g: Game, st: Station, msg: string) {
  const pad = Math.floor(Math.random() * PAD_COUNT);
  g.dock = { station: st, pad, docked: false };
  g.showMsg(`${msg} ${pad + 1}`);
}

/** The ship's last clear position (station unit coordinates) near each station, for bouncing back to. */
const lastClear = new WeakMap<Station, THREE.Vector3>();

/**
 * After the ship moves: collide with any station it's near, notice when it's inside one, and dock
 * on a gentle touchdown on the granted pad.
 */
export function stationContact(g: Game) {
  const { ship } = g;
  // the docking computer's reference: the ship's offset from its station at the end of the step
  const ds = g.dock?.station ?? g.autodockStation;
  if (ds) g.dockRel.subVectors(ship.pos, ds.pos);
  g.inStation = null;
  if (g.dock && !g.dock.docked && g.dock.station.pos.distanceTo(ship.pos) > DOCK_REVOKE_RANGE) {
    g.showMsg(`Docking request expired · ${g.dock.station.name}`, 'warn');
    g.dock = null;
  }
  for (const st of g.cur.stations) {
    if (st.pos.distanceTo(ship.pos) > st.radius + 100) continue;
    const p = toLocal(st, g.simTime, ship.pos, tmp);
    const where = whereIs(p, CLEARANCE / st.size);
    if (where === 'outside') {
      (lastClear.get(st) ?? lastClear.set(st, new THREE.Vector3()).get(st)!).copy(p);
      continue;
    }
    const sysVel = tmp2.copy(ship.vel).add(g.frameBody.vel);
    const vRel = sysVel.sub(stationPointVel(st, ship.pos));
    if (where === 'wall') {
      // on the granted pad, gently, top toward the axis: docked
      const d = g.dock;
      if (d && d.station === st && onPad(st, p, d.pad) && vRel.length() < PAD_SPEED && upOk(g, st, d.pad)) {
        d.docked = true;
        g.autodock = null;
        holdDocked(g);
        g.showMsg(`Docked at ${st.name} · pad ${d.pad + 1} · services below · K launches`);
        return;
      }
      const speed = vRel.length();
      if (speed > STATION_CRASH) {
        destroyShip(g, `Hit ${st.name} at ${speed.toFixed(0)} m/s`, st.parent);
        return;
      }
      // bounce: back to the last clear spot (in the station's own coordinates: mid-step world
      // positions lag the station by its orbital motion), most of the closing speed gone
      const back = lastClear.get(st);
      if (back) toWorld(st, g.simTime, back, ship.pos);
      ship.vel.copy(stationPointVel(st, ship.pos)).addScaledVector(vRel, -0.25).sub(g.frameBody.vel);
      if (!g.warned.bump) {
        g.warned.bump = true;
        g.showMsg(`Contact with ${st.name} · ${speed.toFixed(0)} m/s`, 'warn');
      }
      g.inStation = st;
      g.inStationRel.subVectors(ship.pos, st.pos);
      return;
    }
    g.warned.bump = false;
    g.inStation = st;
    g.inStationRel.subVectors(ship.pos, st.pos);
    (lastClear.get(st) ?? lastClear.set(st, new THREE.Vector3()).get(st)!).copy(p);
    return;
  }
}

/** Is the local point on pad i (close to the wall, within the pad)? */
function onPad(st: Station, p: THREE.Vector3, i: number) {
  const pad = padLocal(i);
  const r = Math.hypot(p.x, p.y);
  if (HANGAR_R - r > PAD_HEIGHT / st.size) return false;
  const dPhi = Math.atan2(Math.sin(Math.atan2(p.y, p.x) - pad.phi), Math.cos(Math.atan2(p.y, p.x) - pad.phi));
  return Math.hypot(dPhi * HANGAR_R, p.z - pad.pos.z) < PAD_R;
}

/** Is the ship's top facing roughly away from the pad (toward the station's axis)? */
function upOk(g: Game, st: Station, i: number) {
  const up = padLocal(i).up.applyQuaternion(stationQuat(st, g.simTime));
  return new THREE.Vector3(0, 1, 0).applyQuaternion(g.ship.q).dot(up) > 0.85;
}

/** Docked: sit on the pad, turning with the station. */
export function holdDocked(g: Game) {
  const d = g.dock!;
  const st = d.station;
  const { ship } = g;
  const pad = padLocal(d.pad);
  const q = stationQuat(st, g.simTime);
  const up = pad.up.clone().applyQuaternion(q);
  toWorld(st, g.simTime, pad.pos, ship.pos).addScaledVector(up, PAD_REST);
  // nose along the station's axis (toward the slot), top toward the axis
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, fwd.clone().negate()).normalize(), up, fwd.clone().negate());
  ship.q.setFromRotationMatrix(m);
  ship.vel.copy(stationPointVel(st, ship.pos)).sub(g.frameBody.vel);
  g.inStation = st;
  g.inStationRel.subVectors(ship.pos, st.pos);
  g.dockRel.copy(g.inStationRel);
  g.curSpeed = 0;
}

/** K while docked: lift straight off the pad. */
export function launch(g: Game) {
  const d = g.dock;
  if (!d?.docked) return;
  const up = padLocal(d.pad).up.applyQuaternion(stationQuat(d.station, g.simTime));
  g.ship.vel.addScaledVector(up, LAUNCH_SPEED);
  g.showMsg(`Launched from ${d.station.name} · fly out through the slot`);
  g.dock = null;
  if (g.ship.avionics.dock?.caps.launch) {
    engageAutoLaunch(g, d.station, d.pad);
    g.showMsg(`Launched from ${d.station.name} · docking computer flying you out`);
  }
}

/**
 * Inside a station, flight assist flies on docking thrusters: gentle acceleration, and a speed limit
 * of STATION_MAX_SPEED that falls off along a braking curve to PAD_SPEED − 1 at the hangar wall,
 * so holding "down" settles you onto a pad instead of into it. Null outside a station.
 */
export function stationLimits(g: Game): { acc: number; maxV: number } | null {
  const st = g.inStation;
  if (!st) {
    // approach control: with a pad granted and the station close, flight assist holds you to an
    // approach speed you can still brake from inside
    const d = g.dock;
    if (d && !d.docked && d.station.pos.distanceTo(g.ship.pos) < APPROACH_RANGE) return { acc: 100, maxV: APPROACH_SPEED };
    return null;
  }
  // from the end-of-step offset (mid-step the ship lags the station by its orbital motion)
  const p = tmp.copy(g.inStationRel).applyQuaternion(stationQuat(st, g.simTime).invert()).divideScalar(st.size);
  const toWall = (HANGAR_R - Math.hypot(p.x, p.y)) * st.size;
  // a braking curve: whatever the limit is here, the thrusters can shed it before the wall even
  // with "down" held (they bleed 2 × STATION_ACC against the held STATION_ACC: a net STATION_ACC,
  // so the curve assumes half of that). A straight taper fell faster than they could brake.
  const maxV = Math.min(STATION_MAX_SPEED, PAD_SPEED - 1 + Math.sqrt(2 * STATION_ACC * 0.5 * Math.max(0, toWall - PAD_HEIGHT)));
  return { acc: STATION_ACC, maxV };
}

/** Within this distance (m) of the station a granted pad caps speed at APPROACH_SPEED (m/s). */
const APPROACH_RANGE = 3000,
  APPROACH_SPEED = 150;

/** Docking thrusters inside a station: acceleration (m/s²) and top speed (m/s). */
const STATION_ACC = 20,
  STATION_MAX_SPEED = 100;

/** Turn the ship with the station while it's inside, so the hangar looks still. */
export function rotationCorrection(g: Game, dt: number) {
  const st = g.inStation;
  if (!st || g.dock?.docked) return;
  g.ship.q.premultiply(new THREE.Quaternion().setFromAxisAngle(st.spinAxis, st.spinRate * dt)).normalize();
}

/** Docked services: fill the tanks (the station's fuel is free for now). */
export function refuelDocked(g: Game) {
  if (!g.dock?.docked) return;
  g.ship.prop = SHIP.propCap;
  g.ship.exotic = SHIP.exoticCap;
  g.showMsg(`${g.dock.station.name} · tanks filled`);
}

/** Where the granted pad is (world), for the HUD. */
export function padWorld(g: Game) {
  const d = g.dock;
  if (!d) return null;
  return toWorld(d.station, g.simTime, padLocal(d.pad).pos);
}

