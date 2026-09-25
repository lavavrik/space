import { AP_ACC, AP_KP, AP_TAU, AP_VMAX } from '../constants';
import { fmtDist, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Autopilot, Gravity, Ship } from '../types';
import { dropAlt, dropFTL, ftlSpeedLimit, ftlUpkeep } from './ftl';
import { applyThrust } from './resources';

/** Ship position relative to the autopilot body, and "up" projected into the orbit plane. */
export function apGeom(ship: Ship, ap: Autopilot) {
  const b = ap.body,
    rv = ship.pos.clone().sub(b.pos),
    r = rv.length(),
    u = rv.clone().divideScalar(r);
  let up = u;
  if (ap.n) {
    up = u.clone().addScaledVector(ap.n, -u.dot(ap.n));
    if (up.lengthSq() < 1e-10) up.set(1, 0, 0).cross(ap.n);
    up.normalize();
  }
  return { b, rv, r, up };
}

/** Where the FTL leg drops out: above the body, in the target plane, at the orbit radius. */
export function apInsertion(ship: Ship, ap: Autopilot) {
  const { b, up } = apGeom(ship, ap);
  const rT = b.radius + Math.max(ap.r0 - b.radius, dropAlt(b) * 1.1);
  return { P: b.pos.clone().addScaledVector(up, rT), rT };
}

/** How far the ship's velocity is from circular orbital velocity. */
export function orbitVelErr(ship: Ship, ap: Autopilot) {
  const { b, up } = apGeom(ship, ap);
  const tang = new THREE.Vector3().crossVectors(ap.n!, up).multiplyScalar(Math.sqrt(b.mu / ap.r0));
  return ship.vel.distanceTo(tang);
}

/** Orbit / station-keeping autopilot: steer velocity toward a desired velocity field
 *  with limited thrust, plus a feed-forward term for gravity and centripetal force. */
export function autopilot(g: Game, dt: number, grav: Gravity) {
  const ship = g.ship;
  const ap = ship.ap!,
    b = ap.body;
  const rv = ship.pos.clone().sub(b.pos),
    r = rv.length(),
    u = rv.clone().divideScalar(r);
  let vDes: THREE.Vector3, aFF: THREE.Vector3;
  if (ap.type === 'hold') {
    const e = ap.point!.clone().sub(ship.pos),
      dist = e.length();
    vDes = e.multiplyScalar(Math.min(AP_KP, AP_VMAX / Math.max(dist, 1)));
    aFF = grav.vec.clone().negate();
    if (!ap.settled && dist < 100 && ship.vel.length() < 5) {
      ap.settled = true;
      g.showMsg(`Holding position ${fmtDist(ap.r0 - b.radius)} above ${b.name}`, 'ftl');
    }
  } else {
    const n = ap.n!;
    const up = u.clone().addScaledVector(n, -u.dot(n));
    if (up.lengthSq() < 1e-10) up.set(1, 0, 0).cross(n);
    up.normalize();
    const vt = Math.sqrt(b.mu / Math.max(r, b.radius));
    const tang = new THREE.Vector3().crossVectors(n, up);
    const clampV = (x: number) => Math.max(-AP_VMAX, Math.min(AP_VMAX, x));
    // climbing or descending costs twice the peak radial speed, so keep it modest
    const er = ap.r0 - r,
      vrMax = Math.min(AP_VMAX, Math.max(300, Math.sqrt(Math.abs(er) * 5)));
    const vr = Math.max(-vrMax, Math.min(vrMax, er * AP_KP));
    const vn = clampV(-rv.dot(n) * AP_KP);
    vDes = tang.multiplyScalar(vt).addScaledVector(up, vr).addScaledVector(n, vn);
    aFF = up
      .clone()
      .multiplyScalar((-vt * vt) / r)
      .sub(grav.vec);
    if (!ap.settled && Math.abs(ap.r0 - r) < Math.max(200, ap.r0 * 0.002) && ship.vel.distanceTo(vDes) < 5 + vt * 0.003) {
      ap.settled = true;
      g.showMsg(`Orbit established · ${fmtDist(ap.r0 - b.radius)} · period ${fmtTime(ap.period)}`, 'ftl');
    }
  }
  const err = vDes.sub(ship.vel);
  const a = err.clone().divideScalar(AP_TAU).add(aFF);
  // once in a stable orbit, ignore tiny errors: a real orbit needs no thrust to keep
  if (ap.settled && ap.type !== 'hold' && err.length() < 1 && Math.abs(ap.r0 - r) < 500) a.set(0, 0, 0);
  if (a.length() > AP_ACC) a.setLength(AP_ACC);
  const T = a.multiplyScalar(dt);
  applyThrust(g, T, dt);
  ship.vel.addScaledVector(grav.vec, dt).add(T);
}

/** Autopilot FTL leg: turn toward the insertion point and fly there, then drop. */
export function ftlTransfer(g: Game, dt: number) {
  const { ship } = g;
  const ap = ship.ap!;
  const { P, rT } = apInsertion(ship, ap);
  const toP = P.clone().sub(ship.pos),
    dist = toP.length();
  const m = new THREE.Matrix4().lookAt(ship.pos, P, new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q));
  ship.q.slerp(new THREE.Quaternion().setFromRotationMatrix(m), Math.min(1, 2.2 * dt));
  g.fwd.set(0, 0, -1).applyQuaternion(ship.q);
  const vmax = ftlSpeedLimit(g);
  const align = Math.max(0, g.fwd.dot(toP) / dist);
  const tgt = Math.min(vmax, dist * 0.8) * Math.pow(align, 8);
  if (ship.ftlSpeed < tgt) ship.ftlSpeed = Math.min(tgt, ship.ftlSpeed * Math.exp(1.5 * dt) + 20000 * dt);
  else ship.ftlSpeed = Math.max(tgt, ship.ftlSpeed * Math.exp(-3 * dt));
  ship.pos.addScaledVector(g.fwd, ship.ftlSpeed * dt);
  g.curSpeed = ship.ftlSpeed;
  if (!ftlUpkeep(g, dt, align)) return;
  if (dist < Math.max(30e3, rT * 0.01)) {
    dropFTL(g, false);
    return;
  }
  for (const o of g.cur.bodies) {
    if (o.pos.distanceTo(ship.pos) - o.radius < dropAlt(o)) {
      dropFTL(g, true, o);
      return;
    }
  }
}
