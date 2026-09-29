import { AP_ACC, AP_FTL_MIN, AP_TAU } from '../constants';
import { fmtDist, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { airDensityAt, airSpeedLimit } from './catapult';
import { stationAcc } from './stations';
import { RING_HALF_THICK } from './rings';
import type { ApproachProfile } from '../avionics/catalog';
import type { Autopilot, Body, Gravity, Ship, Station } from '../types';
import { atmoOf } from './atmosphere';
import { velRel } from './frame';
import { dropAlt, dropFTL, ftlSpeedLimit, ftlUpkeep, massLock } from './ftl';
import { minOrbitAlt } from './orbits';
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

/**
 * Where the FTL leg drops out: above the body, in the target plane, at the orbit radius. For a ring
 * orbit, RING_DROP off the plane (on the ship's side) instead: the drive drops out at rest relative
 * to the world, and in the belt its rocks would sweep by at their orbital speed (5 km/s at Venydes 8:
 * that was a wreck on arrival). The orbit branch then matches the rocks before going in.
 */
export function apInsertion(ship: Ship, ap: Autopilot): { P: THREE.Vector3; rT: number; waypoint?: boolean } {
  if (ap.type === 'rendezvous') {
    // FTL at the station: 20 km short of it, or, if it orbits below the lowest altitude FTL can
    // reach near its world, straight above it at that floor (thrusters take it from there)
    const st = ap.station!,
      b = ap.body;
    const floor = b.radius + dropAlt(b) * 1.1;
    const P =
      st.pos.distanceTo(b.pos) >= floor
        ? st.pos.clone().addScaledVector(ship.pos.clone().sub(st.pos).normalize(), 20e3)
        : b.pos.clone().addScaledVector(st.pos.clone().sub(b.pos).normalize(), floor);
    // go round the world if the line would cross the altitude where FTL cuts out (a little below
    // the floor, so a target sitting on the floor itself doesn't count as crossing)
    const w = aroundBody(ship.pos, P, b, b.radius + dropAlt(b) * 1.02);
    return w ? { P: w, rT: floor, waypoint: true } : { P, rT: P.distanceTo(b.pos) };
  }
  const { b, rv, up } = apGeom(ship, ap);
  const rT = b.radius + Math.max(ap.r0 - b.radius, dropAlt(b) * 1.1);
  const P = b.pos.clone().addScaledVector(up, rT);
  if (ap.type === 'ring') P.addScaledVector(ap.n!, rv.dot(ap.n!) < 0 ? -RING_DROP : RING_DROP);
  return { P, rT };
}

/*
 * Approach profile for closing a distance (altitude, distance out of the orbit plane, distance to a
 * hold point): cruise at up to a cap, brake at `acc` so you arrive at rest, and finish with a short
 * linear tail (time constant 1/APPROACH_K). The braking and caps come from the fitted orbit
 * computer (see avionics/catalog.ts); DEFAULT_PROFILE is the HX-8200's.
 */
export const APPROACH_K = 0.3; // 1/s, final linear tail
/** How fast the ring orbit's autopilot moves across the belt's slab (m/s): see the orbit branch. */
const RING_ENTRY = 15;
/** Where a ring orbit's autopilot crosses the ring, off its plane (m): 1 km clear of the rocks' slab. */
const RING_OVER = RING_HALF_THICK + 1000;
/** Radius changes up to this (m) a ring orbit makes inside the slab, at RING_ENTRY; bigger ones cross over it. */
const RING_SHIFT = 2000;
/** A ring orbit's FTL leg drops out this far off the ring's plane (m). */
const RING_DROP = 20e3;
/** A ring orbit's autopilot enters the slab only moving with the rocks: within this (m/s) of their orbit, in the plane. */
const RING_MATCH = 20;
/** A rendezvous holds this far from the station (m): close enough for its frame, clear of the hull. */
export const RDV_STANDOFF = 2000;
export const DEFAULT_PROFILE: ApproachProfile = { acc: 25, radialCap: 5000, planeCap: 3000 };

/** The fitted orbit computer's approach profile. */
export const profileOf = (ship: Ship) => ship.avionics.orbit?.caps.profile ?? DEFAULT_PROFILE;

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
export function approachSpeed(d: number, cap: number, acc = DEFAULT_PROFILE.acc) {
  return Math.min(cap, Math.sqrt(2 * acc * d), APPROACH_K * d);
}

/** Time (s) the approach profile takes to bring d down to `done`: cruise, braking, then the tail. */
export function approachTime(d: number, cap: number, done: number, acc = DEFAULT_PROFILE.acc) {
  if (d <= done) return 0;
  const x1 = (2 * acc) / (APPROACH_K * APPROACH_K); // below this, the linear tail
  const x2 = (cap * cap) / (2 * acc); // above this, cruising at the cap
  let t = 0;
  if (d > x2) {
    t += (d - x2) / cap;
    d = x2;
  }
  const lo = Math.max(x1, done); // the braking phase ends at the tail, or at the finish if that's sooner
  if (d > lo) {
    t += Math.sqrt(2 / acc) * (Math.sqrt(d) - Math.sqrt(lo));
    d = lo;
  }
  return t + Math.log(Math.max(1, d / done)) / APPROACH_K;
}

/**
 * How far the autopilot still has to go: to the station for a rendezvous, otherwise to the orbit's
 * entry point. (Not to apInsertion's P, which may just be the next waypoint round a world: judging
 * FTL by that ~760 km hop left a ship hovering beside a planet until its tank ran dry.)
 */
export function apDistance(ship: Ship, ap: Autopilot) {
  if (ap.type === 'rendezvous') return ap.station!.pos.distanceTo(ship.pos);
  return apInsertion(ship, ap).P.distanceTo(ship.pos);
}

/**
 * Climb speed (m/s) out of another world's mass lock on the way to a far target. A giant's lock
 * reaches ~9,000 km up; at the approach cap (5–7 km/s) that climb took ~9 minutes, at this ~2.
 * It costs about this much Δv (the FTL leg then drops the ship's own velocity).
 */
const CLIMB_OUT_V = 30e3;

/** Closest distance from point c to the segment a→b. */
function segmentDist(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, c.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9)));
  return a.clone().addScaledVector(ab, t).distanceTo(c);
}

/**
 * If the straight line from `from` to `to` dips inside `radius` of body b, a waypoint that goes
 * round it instead: `from`'s direction turned 5° toward `to`, at `from`'s own distance (but at least
 * 1.1 × radius). Recomputed every frame, chasing a point just ahead traces an arc round the body
 * that sinks by at most ~2.5° and never below 1.1 × radius. (A 45° step dived ~22° per frame of
 * pursuit and flew ships into the planet; a waypoint at a fixed low radius let the chord from high
 * above cut below the FTL floor.) Null when the straight line is clear.
 */
export function aroundBody(from: THREE.Vector3, to: THREE.Vector3, b: Body, radius: number) {
  if (segmentDist(from, to, b.pos) >= radius) return null;
  const u0 = from.clone().sub(b.pos).normalize(),
    u1 = to.clone().sub(b.pos).normalize();
  const axis = new THREE.Vector3().crossVectors(u0, u1);
  if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0).cross(u0); // exactly opposite: any way round
  axis.normalize();
  const step = Math.min(u0.angleTo(u1), (5 * Math.PI) / 180);
  const rho = Math.max(radius * 1.1, from.distanceTo(b.pos));
  return b.pos.clone().addScaledVector(u0.applyAxisAngle(axis, step), rho);
}

/**
 * On the way to a sky station: where to head while not yet over it (null once over it, to go straight
 * down). Over it means in a cone above it: within SKY_COLUMN plus 30 % of the height above it off its
 * vertical. The point is DESCENT_UP over the top of the air above it, reached round the world clear
 * of the air (aroundBody).
 */
export function skyDescent(from: THREE.Vector3, st: Station) {
  const b = st.parent;
  const up = st.pos.clone().sub(b.pos).normalize();
  const rel = from.clone().sub(st.pos);
  const h = rel.dot(up);
  if (h > 0 && rel.addScaledVector(up, -h).length() < SKY_COLUMN + 0.3 * h) return null;
  const top = b.radius + (atmoOf(b)?.top ?? 0);
  const P = b.pos.clone().addScaledVector(up, Math.max(top * DESCENT_UP, st.pos.distanceTo(b.pos) + 10e3));
  return aroundBody(from, P, b, top) ?? P;
}
/** Sky station descent: the column (m) and the point over the air (× the air top's radius). */
const SKY_COLUMN = 3000,
  DESCENT_UP = 1.005;

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
  const prof = profileOf(ship);
  const rv = ship.pos.clone().sub(b.pos),
    r = rv.length(),
    u = rv.clone().divideScalar(r);
  // desired velocities below are relative to the autopilot body, which may not be the frame body
  const vRel = velRel(g, b);
  let vDes: THREE.Vector3, aFF: THREE.Vector3;
  if (ap.type === 'hold') {
    const e = holdPoint(ap).sub(ship.pos),
      dist = e.length();
    vDes = e.multiplyScalar(approachSpeed(dist, prof.radialCap, prof.acc) / Math.max(dist, 1));
    aFF = grav.vec.clone().negate();
    if (!ap.settled && dist < 100 && vRel.length() < 5) {
      ap.settled = true;
      g.showMsg(`Holding position ${fmtDist(ap.r0 - b.radius)} above ${b.name}`, 'ftl');
    }
  } else if (ap.type === 'rendezvous') {
    // Close on a moving station and match it: aim for a point RDV_STANDOFF short of it, arriving at
    // its velocity. The feed-forward is the station's acceleration minus our gravity: for one in
    // orbit we both fall toward its world (nearly equal, so rendezvous burns are small once close);
    // a sky station is held up, so we must be too.
    const st = ap.station!;
    const toSt = st.pos.clone().sub(ship.pos),
      dist = toSt.length();
    const vSt = st.vel.clone().sub(b.vel); // relative to the autopilot body, like vRel
    const close = Math.max(0, dist - RDV_STANDOFF);
    // keep clear of the world, but never by more than half the station's own altitude (a low
    // station would otherwise sit inside the no-go sphere and never be approached)
    const clear = st.sky ? 0 : Math.min(minOrbitAlt(b) * 3, (st.pos.distanceTo(b.pos) - b.radius) * 0.5);
    const way = aroundBody(ship.pos, st.pos, b, b.radius + clear);
    const ftlFloor = b.radius + dropAlt(b) * 1.25; // just above where FTL can start near this world
    const descent = st.sky ? skyDescent(ship.pos, st) : null;
    if ((way || descent) && dist > 2000e3 && g.ship.avionics.orbit?.caps.ftlLeg && r < ftlFloor) {
      // far round the other side and too low for FTL: climb out first, then the FTL leg takes over
      // (crawling round a world on thrusters took up to half an hour)
      vDes = u.clone().multiplyScalar(approachSpeed(ftlFloor - r, prof.radialCap, prof.acc) + 50);
      aFF = grav.vec.clone().negate();
    } else if (descent) {
      // a sky station, and not yet over it: to the point above it, over the air, then straight down
      // (flying to it through the air would crawl at the air's speed limit, burning propellant just
      // to stay up)
      // (the point turns with the world, as the station does)
      const turn = b.axis.clone().multiplyScalar(b.spin).cross(descent.clone().sub(b.pos));
      const toW = descent.sub(ship.pos),
        dW = toW.length();
      vDes = turn.addScaledVector(toW, approachSpeed(dW, prof.radialCap, prof.acc) / Math.max(dW, 1));
      aFF = grav.vec.clone().negate();
    } else if (way) {
      // the station is round the far side: go round the world first
      const toW = way.sub(ship.pos),
        dW = toW.length();
      vDes = toW.multiplyScalar(approachSpeed(dW, prof.radialCap, prof.acc) / Math.max(dW, 1));
      aFF = grav.vec.clone().negate();
    } else {
      vDes = vSt.clone().addScaledVector(toSt, approachSpeed(close, prof.radialCap, prof.acc) / Math.max(dist, 1));
      // a sky station doesn't fall with us: its acceleration is only its turn with the world
      aFF = stationAcc(st).sub(grav.vec);
    }
    if (st.sky) {
      // in the air, to a sky station: no faster through it than it allows (sim/catapult.ts), relative
      // to the station (which turns with the world, as the air does)
      const rho = airDensityAt(st.parent, ship.pos);
      const cap = airSpeedLimit(rho);
      const d = vDes.clone().sub(vSt);
      if (rho > 0 && d.length() > cap) vDes.copy(vSt).add(d.setLength(cap));
    }
    if (!ap.settled && close < 1000 && vRel.distanceTo(vSt) < 2) {
      ap.settled = true;
      g.showMsg(`Rendezvous with ${st.name} · holding ${fmtDist(dist)} off`, 'ftl');
    }
  } else {
    const n = ap.n!;
    const up = u.clone().addScaledVector(n, -u.dot(n));
    if (up.lengthSq() < 1e-10) up.set(1, 0, 0).cross(n);
    up.normalize();
    // climbing / descending and moving into the plane each cost twice their peak speed in Δv,
    // hence the caps; the braking profile makes them arrive at rest instead of creeping in
    const er = ap.r0 - r,
      z = rv.dot(n); // height over the orbit's plane
    const vt = Math.sqrt(b.mu / Math.max(r, b.radius));
    const tang = new THREE.Vector3().crossVectors(n, up);
    // A ring orbit never moves across the belt inside its slab: that ploughs through the rocks at
    // up to radialCap (5 km/s; a shallow approach, arriving near the plane at another radius, was
    // wrecked on the first boulder). Until the radius is right it holds RING_OVER above (or below)
    // the slab, on the side it's on, and crosses over the rocks; then it comes down into the slab.
    // A short move (stepping aside from a rock, the last trim) stays in the slab at RING_ENTRY. And
    // it only goes in moving with the rocks (within RING_MATCH, in the plane): not from a standstill
    // over them, as after the FTL leg.
    const inSlab = Math.abs(z) < RING_HALF_THICK + 300;
    const slip = vRel.clone().addScaledVector(tang, -vt).addScaledVector(n, -vRel.dot(n)).length();
    const ringCross = ap.type === 'ring' && (Math.abs(er) > RING_SHIFT || (!inSlab && slip > RING_MATCH));
    const zGoal = ringCross ? (z < 0 ? -1 : 1) * RING_OVER : 0;
    const dn = zGoal - z;
    let vr = ringCross && inSlab ? 0 : Math.sign(er) * approachSpeed(Math.abs(er), prof.radialCap, prof.acc);
    if (ap.type === 'ring' && inSlab) vr = Math.sign(vr) * Math.min(Math.abs(vr), RING_ENTRY);
    let vn = Math.sign(dn) * approachSpeed(Math.abs(dn), prof.planeCap, prof.acc);
    // through a ring's slab, slowly: RING_ENTRY inside it, and braking to that by its edge coming
    // in, so the pebbles met on the way (one or two, crossing a dense band) are bumps, not hits
    // (sim/ringContact.ts)
    if (ap.type === 'ring') {
      const cap = inSlab ? RING_ENTRY : z * dn < 0 ? Math.sqrt(RING_ENTRY * RING_ENTRY + 2 * prof.acc * (Math.abs(z) - RING_HALF_THICK - 300)) : Infinity;
      vn = Math.sign(vn) * Math.min(Math.abs(vn), cap);
    }
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
  // Mass-locked by a world other than the target's (e.g. setting off from low over a gas giant for
  // a station round another planet) with the target still far: climb straight out of the lock
  // first; maybeFtlLeg then starts the FTL leg. Otherwise the thruster path went round that world
  // at the same altitude, never leaving the lock (a big giant's reaches ~9,000 km up), and crawled.
  const lock = massLock(g);
  if (lock && lock !== b && ap.type !== 'hold' && ship.avionics.orbit?.caps.ftlLeg && apDistance(ship, ap) > 2 * AP_FTL_MIN) {
    const ul = ship.pos.clone().sub(lock.pos),
      rl = ul.length();
    // radially away from the locking world at CLIMB_OUT_V (no braking at the top: the FTL leg takes
    // over there), in its frame, then expressed relative to the autopilot body
    vDes = ul.multiplyScalar(CLIMB_OUT_V / rl).add(lock.vel).sub(b.vel);
    aFF = grav.vec.clone().negate();
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
  const ins = apInsertion(ship, ap);
  let { P, waypoint } = ins;
  const { rT } = ins;
  // other worlds in the way (e.g. the gas giant just left, when the target lies beyond it): go round
  // them clear of their FTL drop-out altitude too, or the leg dives into the well, drops out, climbs
  // back on thrusters and tries again, round and round
  for (const o of g.cur.bodies) {
    if (o === ap.body) continue;
    const w = aroundBody(ship.pos, P, o, o.radius + dropAlt(o) * 1.1);
    if (w) {
      P = w;
      waypoint = true;
      break;
    }
  }
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
  if (!waypoint && dist < Math.max(30e3, rT * 0.01)) {
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
