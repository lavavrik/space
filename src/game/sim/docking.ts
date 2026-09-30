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
 *
 * Sky stations (sim/skyGeom.ts) are open decks: no slot, no hangar, no spin to match. With a pad
 * granted you fly down onto it from above like landing anywhere else, gently and upright (the
 * world's gravity is "down" here), and K lifts you off again. Or the catapult throws you up and
 * flies you out of the air (sim/catapult.ts).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Station } from '../types';
import { impact } from './damage';
import { engageAutoLaunch, engageAutodock } from './autodock';
import { startDockGuide } from './guide';
import { overDeck } from './skyGeom';
import { HANGAR_R, PAD_R, padCount, padOf, stationPointVel, stationQuat, toLocal, toWorld, whereIsAt } from './stationGeom';
import { freePads, pilotName, rootOf, slotUser } from './control';
import { learnSystem } from './scanner';

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
/** Hitting the structure: faster than STATION_SCRAPE (m/s) damages the hull, and at STATION_CRASH takes all of it. */
const STATION_SCRAPE = 3,
  STATION_CRASH = 35;
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
    startDockGuide(g, t);
    return true;
  }
  if (dist > DOCK_REQUEST_RANGE) {
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
  if (g.dockRequest?.station === t) {
    g.showMsg(`Waiting for ${t.name} traffic control…`);
    return true;
  }
  requestDocking(g, t);
  // a docking computer takes it from here: it holds position until the pad comes through
  if (g.ship.avionics.dock) engageAutodock(g, t);
  return true;
}

/** Traffic control answers a docking request after this long (s), give or take. */
const REPLY_TIME = [4, 8];

/** With every pad taken, traffic control asks again this often (s). */
const PAD_RETRY = 10;

/** Ask for a pad: traffic control answers after a few seconds (updateDockRequest). */
export function requestDocking(g: Game, st: Station) {
  g.dock = null;
  g.dockRequest = { station: st, t: REPLY_TIME[0] + Math.random() * (REPLY_TIME[1] - REPLY_TIME[0]) };
  g.showMsg(`Requesting docking · ${st.name}…`);
  startDockGuide(g, st);
}

/** Each frame: count down a pending request; when traffic control answers, the pad is granted. */
export function updateDockRequest(g: Game, dt: number) {
  const r = g.dockRequest;
  if (!r) return;
  if (r.station.pos.distanceTo(g.ship.pos) > DOCK_REVOKE_RANGE) {
    g.dockRequest = null;
    g.showMsg(`Docking request dropped · out of ${r.station.name}'s range`, 'warn');
    return;
  }
  r.t -= dt;
  if (r.t > 0) return;
  // a pad no other ship holds (sim/control.ts); all taken: wait in the queue and ask again
  const free = freePads(g, r.station);
  if (!free.length) {
    r.t = PAD_RETRY;
    if (!r.full) g.showMsg(`${r.station.name} · all ${padCount(r.station)} pads taken · you're queued, hold nearby`, 'warn');
    r.full = true;
    return;
  }
  g.dockRequest = null;
  const pad = free[Math.floor(Math.random() * free.length)];
  g.dock = { station: r.station, pad, docked: false };
  const busy = slotUser(g, r.station);
  const how = r.station.sky ? ' · land on it from above' : busy ? ` · hold short: ${pilotName(g, busy)} is in the slot` : ' · enter through the slot, matching its spin';
  g.showMsg(`Docking granted · ${r.station.name} · pad ${pad + 1}${g.autodock ? '' : how}`);
  g.invalidateHud();
}

/**
 * Each ship's last clear position (station unit coordinates) near each station, for bouncing back
 * to. Per ship: other ships (sim/traffic.ts) fly this same code.
 */
const clearSpots = new WeakMap<object, WeakMap<Station, THREE.Vector3>>();

/**
 * After the ship moves: collide with any station it's near, notice when it's inside one, and dock
 * on a gentle touchdown on the granted pad.
 */
export function stationContact(g: Game) {
  const { ship } = g;
  const lastClear = clearSpots.get(ship) ?? clearSpots.set(ship, new WeakMap()).get(ship)!;
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
    const where = whereIsAt(st, p, CLEARANCE / st.size);
    if (where === 'outside') {
      (lastClear.get(st) ?? lastClear.set(st, new THREE.Vector3()).get(st)!).copy(p);
      continue;
    }
    const sysVel = tmp2.copy(ship.vel).add(g.frameBody.vel);
    const vRel = sysVel.sub(stationPointVel(st, ship.pos));
    if (where === 'wall') {
      // on the granted pad, gently, top toward the axis (up, on a sky deck): docked
      const d = g.dock;
      if (d && d.station === st && onPad(st, p, d.pad) && vRel.length() < PAD_SPEED && upOk(g, st, d.pad)) {
        d.docked = true;
        g.autodock = null;
        holdDocked(g);
        g.showMsg(`Docked at ${st.name} · pad ${d.pad + 1} · K ${st.sky ? 'lifts off · or take the catapult' : 'launches'}`);
        if (rootOf(g) === g) {
          // yours (not another ship's): the station window, and the station's charts of the system
          const n = learnSystem(g);
          g.openStation();
          if (n) g.showMsg(`Docked at ${st.name} · its charts identify ${n} world${n > 1 ? 's' : ''} and station${n > 1 ? 's' : ''} in ${g.cur.sys.name}`);
        }
        return;
      }
      // hitting the structure damages the hull: a scrape under STATION_SCRAPE, a whole hull's worth
      // at STATION_CRASH (sim/damage.ts)
      const speed = vRel.length();
      const h0 = ship.hull;
      if (impact(g, speed, STATION_SCRAPE, STATION_CRASH, st.name, st.parent)) return;
      // bounce: back to the last clear spot (in the station's own coordinates: mid-step world
      // positions lag the station by its orbital motion), most of the closing speed gone
      const back = lastClear.get(st);
      if (back) toWorld(st, g.simTime, back, ship.pos);
      ship.vel.copy(stationPointVel(st, ship.pos)).addScaledVector(vRel, -0.25).sub(g.frameBody.vel);
      if (!g.warned.bump) {
        g.warned.bump = true;
        if (ship.hull >= h0 - 0.01) g.showMsg(`Contact with ${st.name} · ${speed.toFixed(0)} m/s`, 'warn');
      }
      if (st.sky) return; // open to the sky: never "inside"
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

/** Is the local point on pad i (close to the wall, or the deck, within the pad)? */
function onPad(st: Station, p: THREE.Vector3, i: number) {
  const pad = padOf(st, i);
  if (st.sky) return p.z < PAD_HEIGHT / st.size && Math.hypot(p.x - pad.pos.x, p.y - pad.pos.y) < PAD_R;
  const r = Math.hypot(p.x, p.y);
  if (HANGAR_R - r > PAD_HEIGHT / st.size) return false;
  const dPhi = Math.atan2(Math.sin(Math.atan2(p.y, p.x) - pad.phi), Math.cos(Math.atan2(p.y, p.x) - pad.phi));
  return Math.hypot(dPhi * HANGAR_R, p.z - pad.pos.z) < PAD_R;
}

/** Is the ship's top facing roughly away from the pad (toward the station's axis; up, on a deck)? */
function upOk(g: Game, st: Station, i: number) {
  const up = padOf(st, i).up.applyQuaternion(stationQuat(st, g.simTime));
  return new THREE.Vector3(0, 1, 0).applyQuaternion(g.ship.q).dot(up) > 0.85;
}

/** Docked: sit on the pad, turning with the station. */
export function holdDocked(g: Game) {
  const d = g.dock!;
  const st = d.station;
  const { ship } = g;
  const pad = padOf(st, d.pad);
  const q = stationQuat(st, g.simTime);
  const up = pad.up.clone().applyQuaternion(q);
  toWorld(st, g.simTime, pad.pos, ship.pos).addScaledVector(up, PAD_REST);
  // nose along the station's axis (toward the slot), top toward the axis; on a deck, nose outward, top up
  const fwd = pad.fwd.clone().applyQuaternion(q);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, fwd.clone().negate()).normalize(), up, fwd.clone().negate());
  ship.q.setFromRotationMatrix(m);
  ship.vel.copy(stationPointVel(st, ship.pos)).sub(g.frameBody.vel);
  // on an open deck you're in the open air and sunlight, not inside
  g.inStation = st.sky ? null : st;
  g.inStationRel.subVectors(ship.pos, st.pos);
  g.dockRel.copy(g.inStationRel);
  g.curSpeed = 0;
}

/** K while docked: lift straight off the pad. */
export function launch(g: Game) {
  const d = g.dock;
  if (!d?.docked) return;
  const up = padOf(d.station, d.pad).up.applyQuaternion(stationQuat(d.station, g.simTime));
  g.ship.vel.addScaledVector(up, LAUNCH_SPEED);
  g.showMsg(`Launched from ${d.station.name}${d.station.sky ? '' : ' · fly out through the slot'}`);
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
    if (!d || d.docked || d.station.pos.distanceTo(g.ship.pos) > APPROACH_RANGE) return null;
    // over a sky station's open deck: the docking thrusters and the braking curve down to it, as
    // above a hangar's wall (from the end-of-step offset, like inside a cube)
    const sk = d.station;
    if (sk.sky) {
      const p = tmp.copy(g.dockRel).applyQuaternion(stationQuat(sk, g.simTime).invert()).divideScalar(sk.size);
      if (p.z > 0 && overDeck(p, 0.1)) return { acc: STATION_ACC, maxV: brakeCurve(p.z * sk.size) };
    }
    return { acc: 100, maxV: APPROACH_SPEED };
  }
  // from the end-of-step offset (mid-step the ship lags the station by its orbital motion)
  const p = tmp.copy(g.inStationRel).applyQuaternion(stationQuat(st, g.simTime).invert()).divideScalar(st.size);
  const toWall = (HANGAR_R - Math.hypot(p.x, p.y)) * st.size;
  // a braking curve: whatever the limit is here, the thrusters can shed it before the wall even
  // with "down" held (they bleed 2 × STATION_ACC against the held STATION_ACC: a net STATION_ACC,
  // so the curve assumes half of that). A straight taper fell faster than they could brake.
  return { acc: STATION_ACC, maxV: brakeCurve(toWall) };
}

/** The speed limit (m/s) `h` metres from a hangar wall or a deck: see stationLimits. */
const brakeCurve = (h: number) => Math.min(STATION_MAX_SPEED, PAD_SPEED - 1 + Math.sqrt(2 * STATION_ACC * 0.5 * Math.max(0, h - PAD_HEIGHT)));

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

/** Where the granted pad is (world), for the HUD. */
export function padWorld(g: Game) {
  const d = g.dock;
  if (!d) return null;
  return toWorld(d.station, g.simTime, padOf(d.station, d.pad).pos);
}

