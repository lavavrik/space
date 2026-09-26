import { CRASH_SPEED, NORMAL_ACC, NORMAL_BOOST, NORMAL_MAX, RESPAWN_TIME, WT } from '../constants';
import { fmtDist, nf0 } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Gravity } from '../types';
import { frameVel } from './frame';
import { dropAlt } from './ftl';
import { lookAt } from './navigation';
import { closePlanner, disengageAP } from './planner';
import { applyThrust, refillShip } from './resources';

const tmp = new THREE.Vector3();

/** Manual flight. Gravity always acts. Flight assist damps drift on axes you are not
 *  thrusting on, but near a body it leaves the velocity along the pull alone, so you
 *  fall unless you thrust away. Near a station it works relative to the station instead
 *  (see sim/frame.ts): you fall together, so it holds you still beside it. With flight
 *  assist off the ship is purely Newtonian.
 *  `inp` is the thrust input in ship axes: [right, up, back]. */
export function manualFlight(g: Game, dt: number, grav: Gravity, inp: number[]) {
  const { ship, keys } = g;
  const boost = keys.ShiftLeft || keys.ShiftRight;
  const acc = boost ? NORMAL_ACC * 3 : NORMAL_ACC,
    maxV = boost ? NORMAL_BOOST : NORMAL_MAX;
  ship.vel.addScaledVector(grav.vec, dt);
  // everything below works in the local frame: the station's, or the system's
  const fv = frameVel(g);
  const v0 = ship.vel.clone().sub(fv);

  const gh = tmp.copy(grav.vec).normalize();
  const stopping = keys.KeyX;
  // how much of the pull flight assist ignores: none in deep space, all of it near a body,
  // none in a station's frame (the station falls with you)
  const w = stopping || g.refFrame ? 0 : Math.min(1, Math.max(0, (grav.g - 0.02) / 0.3));
  const radial = gh.clone().multiplyScalar(v0.dot(gh) * w);
  const rest = v0.clone().sub(radial);
  const lv = rest.clone().applyQuaternion(g.qInv);
  const arr = [lv.x, lv.y, lv.z];
  for (let c = 0; c < 3; c++) {
    if (stopping) {
      arr[c] -= Math.sign(arr[c]) * Math.min(Math.abs(arr[c]), NORMAL_ACC * 3 * dt);
      continue;
    }
    if (inp[c] !== 0) arr[c] += inp[c] * acc * dt;
    else if (ship.fa) arr[c] -= Math.sign(arr[c]) * Math.min(Math.abs(arr[c]), acc * 0.7 * dt);
  }
  lv.set(arr[0], arr[1], arr[2]);
  // after a boost, flight assist bleeds speed back down to the normal limit
  const sp = lv.length();
  if (ship.fa && !boost && sp > maxV) lv.setLength(Math.max(maxV, sp - NORMAL_ACC * 4 * dt));
  // T is the velocity change the thrusters deliver this frame
  const T = lv.applyQuaternion(ship.q).sub(rest);
  // Flight assist enforces the speed limit: thrust may not add speed along the direction
  // of travel past it. Braking and sideways thrust always work; gravity is never limited.
  // With flight assist off there is no limit at all, only propellant.
  if (ship.fa) {
    const s = v0.length();
    if (s > 1e-6) {
      const vh = v0.clone().divideScalar(s);
      const ta = T.dot(vh),
        allow = Math.max(0, maxV - s);
      if (ta > allow) T.addScaledVector(vh, allow - ta);
    }
  }
  applyThrust(g, T, dt);
  ship.vel.copy(v0).add(T).add(fv);
  if (inp[0] || inp[1] || inp[2]) ship.landed = null;
}

/** Surface contact: gentle touchdown lands you, anything faster is a crash. */
export function collide(g: Game, dt: number) {
  const { ship } = g;
  for (const b of g.cur.bodies) {
    const rel = tmp.subVectors(ship.pos, b.pos);
    const d = rel.length();
    const min = b.radius + 30;
    if (d >= min) {
      if (ship.landed === b && d > min + 20) ship.landed = null;
      continue;
    }
    rel.divideScalar(d);
    const vin = -ship.vel.dot(rel);
    if (b.kind === 'star') {
      destroyShip(g, `Burned up in the photosphere of ${b.name}`, b);
      return;
    }
    if (b.type >= WT.GasGiant) {
      destroyShip(g, `Crushed in the atmosphere of ${b.name} · gas giants have no surface`, b);
      return;
    }
    if (vin > CRASH_SPEED) {
      destroyShip(g, `Hit ${b.name} at ${nf0.format(vin)} m/s`, b);
      return;
    }
    ship.pos.copy(b.pos).addScaledVector(rel, min);
    if (vin > 0) ship.vel.addScaledVector(rel, vin);
    // ground friction
    const vtan = ship.vel.clone().addScaledVector(rel, -ship.vel.dot(rel));
    ship.vel.addScaledVector(vtan, -Math.min(1, 4 * dt));
    if (ship.ap) disengageAP(g);
    if (ship.landed !== b) {
      ship.landed = b;
      g.showMsg(`Touchdown on ${b.name} · ${vin.toFixed(0)} m/s`);
    }
  }
}

export function destroyShip(g: Game, reason: string, body: Body) {
  const { ship } = g;
  ship.dead = { t: RESPAWN_TIME, reason, body };
  ship.ap = null;
  ship.ftlCharge = 0;
  ship.landed = null;
  ship.vel.set(0, 0, 0);
  closePlanner(g);
}

export function respawn(g: Game) {
  const { ship } = g;
  const b = ship.dead!.body;
  const u = ship.pos.clone().sub(b.pos).normalize();
  const alt = b.kind === 'star' ? b.radius * 20 : Math.max(dropAlt(b) * 2, b.radius * 1.5);
  ship.pos.copy(b.pos).addScaledVector(u, b.radius + alt);
  ship.vel.set(0, 0, 0);
  ship.mode = 'normal';
  ship.fa = true;
  ship.sunTrack = false;
  ship.tanker = null;
  refillShip(g);
  lookAt(ship, b.pos);
  ship.dead = null;
  g.showMsg(`Replacement ship delivered ${fmtDist(alt)} above ${b.name} · tanks full`);
}
