import { AP_ACC, AP_TAU } from '../constants';
import { fmtDist, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Autopilot, Gravity, Ship } from '../types';
import { velRel } from './frame';
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

/*
 * Approach profile for closing a distance (altitude, distance out of the orbit plane, distance to a
 * hold point): cruise at up to `cap`, brake at APPROACH_ACC so you arrive at rest, and finish with a
 * short linear tail (time constant 1/APPROACH_K). Replaces a pure proportional law whose 17 s
 * exponential tail and 2.5 m/s² braking made insertions take a quarter of an hour.
 */
export const APPROACH_ACC = 25; // m/s², braking
export const APPROACH_K = 0.3; // 1/s, final linear tail
export const RADIAL_CAP = 5000; // m/s, climb / descent
export const PLANE_CAP = 3000; // m/s, sideways into the orbit plane (these cost Δv both ways)

/** Settling an orbit: trim to within this before announcing it (m, m/s)... */
export const ORBIT_TRIM = { alt: 100, vel: 1 };
/**
 * ...then coast, with no thrust at all, while it stays within this. The altitude band scales with
 * the orbit: a leftover speed error δv swings the altitude by about ±2rδv/v, which is ~10 km for
 * 1 m/s high up (a fixed 1 km band made high orbits re-trim every so often).
 */
export const ORBIT_BAND = { alt: 1000, vel: 3 };
export const orbitBandAlt = (r: number, v: number) => Math.max(ORBIT_BAND.alt, (3 * r * ORBIT_TRIM.vel) / v);

/** Speed to close a remaining distance d (m). */
export function approachSpeed(d: number, cap: number) {
  return Math.min(cap, Math.sqrt(2 * APPROACH_ACC * d), APPROACH_K * d);
}

/** Time (s) the approach profile takes to bring d down to `done`: cruise, braking, then the tail. */
export function approachTime(d: number, cap: number, done: number) {
  if (d <= done) return 0;
  const x1 = (2 * APPROACH_ACC) / (APPROACH_K * APPROACH_K); // below this, the linear tail
  const x2 = (cap * cap) / (2 * APPROACH_ACC); // above this, cruising at the cap
  let t = 0;
  if (d > x2) {
    t += (d - x2) / cap;
    d = x2;
  }
  const lo = Math.max(x1, done); // the braking phase ends at the tail, or at the finish if that's sooner
  if (d > lo) {
    t += Math.sqrt(2 / APPROACH_ACC) * (Math.sqrt(d) - Math.sqrt(lo));
    d = lo;
  }
  return t + Math.log(Math.max(1, d / done)) / APPROACH_K;
}

/**
 * How far the ship's orbital (horizontal, in-plane) speed is from circular speed at its current
 * radius. Climbing, descending and moving into the plane are left to their own steps, so this can
 * be matched straight away instead of waiting for the altitude (which is why it used to stall).
 */
export function orbitVelErr(g: Game, ap: Autopilot) {
  const { b, r, up } = apGeom(g.ship, ap);
  const tang = new THREE.Vector3().crossVectors(ap.n!, up);
  return Math.abs(velRel(g, b).dot(tang) - Math.sqrt(b.mu / Math.max(r, b.radius)));
}

/** The hold point in the system frame (it's stored as an offset from the moving body). */
export function holdPoint(ap: Autopilot) {
  return ap.body.pos.clone().add(ap.point!);
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
  // desired velocities below are relative to the autopilot body, which may not be the frame body
  const vRel = velRel(g, b);
  let vDes: THREE.Vector3, aFF: THREE.Vector3;
  if (ap.type === 'hold') {
    const e = holdPoint(ap).sub(ship.pos),
      dist = e.length();
    vDes = e.multiplyScalar(approachSpeed(dist, RADIAL_CAP) / Math.max(dist, 1));
    aFF = grav.vec.clone().negate();
    if (!ap.settled && dist < 100 && vRel.length() < 5) {
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
    // climbing / descending and moving into the plane each cost twice their peak speed in Δv,
    // hence the caps; the braking profile makes them arrive at rest instead of creeping in
    const er = ap.r0 - r,
      dn = -rv.dot(n);
    const vr = Math.sign(er) * approachSpeed(Math.abs(er), RADIAL_CAP);
    const vn = Math.sign(dn) * approachSpeed(Math.abs(dn), PLANE_CAP);
    const vCirc = tang.clone().multiplyScalar(vt); // circular velocity here (before tang is reused below)
    vDes = tang.multiplyScalar(vt).addScaledVector(up, vr).addScaledVector(n, vn);
    aFF = up
      .clone()
      .multiplyScalar((-vt * vt) / r)
      .sub(grav.vec);
    // Settled = the trim is done: within ORBIT_TRIM of the altitude, plane and circular velocity.
    // (Announcing earlier left ~16 kg of trim burns right after "Orbit established"; comparing
    // against the steering velocity vDes announced it mid-dive.)
    const dAlt = Math.abs(ap.r0 - r),
      dPlane = Math.abs(rv.dot(n)),
      dVel = vRel.distanceTo(vCirc);
    if (!ap.settled && dAlt < ORBIT_TRIM.alt && dPlane < ORBIT_TRIM.alt && dVel < ORBIT_TRIM.vel) {
      ap.settled = true;
      g.showMsg(`Orbit established · ${fmtDist(ap.r0 - b.radius)} · period ${fmtTime(ap.period)}`, 'ftl');
    }
    // Once settled, coast: a real orbit needs no thrust. Only if it drifts out of the ORBIT_BAND
    // (it shouldn't, short of a collision or a disengage-and-re-engage) does it go back to trimming.
    if (ap.settled) {
      const band = orbitBandAlt(ap.r0, vt);
      if (dAlt < band && dPlane < band && dVel < ORBIT_BAND.vel) {
        ship.vel.addScaledVector(grav.vec, dt);
        return;
      }
      ap.settled = false;
    }
  }
  const err = vDes.sub(vRel);
  const a = err.clone().divideScalar(AP_TAU).add(aFF);
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
