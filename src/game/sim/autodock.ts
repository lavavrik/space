/*
 * Docking computer (avionics kind 'dock'): it flies the ship in the way a careful pilot would
 * (sim/docking.ts has the manual procedure). The WD-100 takes over once you've been granted a pad
 * (K); the WD-300 can be engaged from 50 km out with K, flies toward the station, and asks for a
 * pad itself on reaching DOCK_REQUEST_RANGE.
 *
 *   approach — (WD-300, engaged from afar) toward the station until in range to ask for a pad
 *   wait    — request sent: hold still until traffic control answers
 *   hold    — to a point on the station's spin axis, HOLD_OUT in front of the slot, at rest
 *             against the station's orbit
 *   align   — nose toward the slot along the axis, wings along the slot's long side, rolling with
 *             the station as it turns
 *   enter   — straight down the axis, through the slot, to the hangar's axis level with the pad row
 *   descend — out across the hangar to just above the pad, top toward the axis, then settle onto it
 *             (docking.ts notices the touchdown)
 *
 * With a WD-300 it also flies you out after launch:
 *
 *   rise    — back up off the pad to the hangar's axis
 *   exit    — out along the axis through the slot to the hold point, then hands back control
 *
 * Positions are worked out in the station's own coordinates from the ship's end-of-step offset
 * (Game.dockRel), because mid-step the ship lags an orbiting station by its orbital motion
 * (docs/docking.md). Guidance is a speed profile toward each point, matched to the station's
 * structure there (orbit + spin), with thrust capped at AUTO_ACC; it uses real propellant and power.
 * Any thrust key hands control back.
 *
 * A sky station (sim/skyGeom.ts) is simpler: no slot and no spin. The hold point is high over the
 * deck's centre; 'align' turns the ship upright, nose outward; 'enter' goes to a point PAD_ABOVE
 * over the pad; 'descend' settles onto it. 'rise' and 'exit' go back up the same way. The station
 * doesn't fall with the ship (its fans hold it up), so the computer holds the ship up against
 * gravity too, and in the air it keeps under the speed the air allows (sim/catapult.ts).
 *
 * Getting to the hold point it never cuts through the station: if the straight line would pass
 * within KEEP_OUT of it (the spinning hull's corners move at ~70 m/s, so any touch is fatal), it
 * climbs out to a safe sphere around the station and flies round it toward the slot's side
 * (clearPath).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Station } from '../types';
import { DOCK_REQUEST_RANGE, requestDocking } from './docking';
import { applyThrust } from './resources';
import { airDensityAt, airSpeedLimit } from './catapult';
import { CORRIDOR_M, HANGAR_R, deckCentre, isDeck, padOf, stationPointVelAt, stationQuat } from './stationGeom';
import { stationAcc } from './stations';
import { NORMAL_ACC } from '../constants';
import { pilotName, queuePlace, slotUser, SLOT_QUEUE } from './control';

export type AutoPhase = 'approach' | 'wait' | 'hold' | 'align' | 'enter' | 'descend' | 'rise' | 'exit';

/** How far out on the axis the approach holds before going in (m). */
export const HOLD_OUT = 600;
/** Beyond this from the station (m) the approach may go up to FAR_SPEED (m/s). */
const APPROACH_NEAR = 3000,
  FAR_SPEED = 1500;
/** Thrust the computer allows itself (m/s²), and how quickly it corrects velocity (s). */
const AUTO_ACC = 25,
  TAU = 0.6;
/** How hard it stops (m/s²) when it's asked for a pad while still moving fast. */
const WAIT_BRAKE = 100;
/** Braking it plans with (m/s²): well under AUTO_ACC so it always has margin. */
const BRAKE = 8;
/** Clearance it keeps from the station's circumscribed sphere (m), and the radius (× size, + m) of
 * the sphere it flies round on when the station is in the way. */
const KEEP_OUT = 150,
  AROUND_K = 1.2,
  AROUND_M = 250;
/** How far ahead along the way round it aims (rad): the ship curves round rather than cutting in. */
const AROUND_STEP = 0.5;
/** Within this of the hold point (m) the nose turns from the way ahead to the slot's orientation. */
const FACE_SLOT = 250;

/**
 * Where to head for `target` from `p` (both in station coordinates, m) without passing through the
 * station of size S: the target itself if the way is clear, else a point on a sphere round the
 * station, a little further round toward the target's side (and out to that sphere if closer).
 */
export function clearPath(p: THREE.Vector3, target: THREE.Vector3, S: number) {
  const hull = S * 0.87 + KEEP_OUT; // circumscribed sphere of the cube, plus margin
  // closest approach of the segment p → target to the station's centre
  const d = target.clone().sub(p);
  const t = Math.max(0, Math.min(1, -p.dot(d) / Math.max(d.lengthSq(), 1e-9)));
  // nearest at the target itself: the way there is clear (the target is chosen clear of the hull; on
  // a big station the hold point, HOLD_OUT off the slot's face, is inside this sphere, and counting
  // it as "in the way" parked the ship on the axis 15 km out for good)
  if (t >= 1 || p.clone().addScaledVector(d, t).length() > hull) return target;
  const R = S * AROUND_K + AROUND_M;
  const pn = p.clone().normalize(),
    tn = target.clone().normalize();
  let axis = new THREE.Vector3().crossVectors(pn, tn);
  if (axis.lengthSq() < 1e-8) axis = new THREE.Vector3().crossVectors(pn, Math.abs(pn.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
  axis.normalize();
  const step = Math.min(pn.angleTo(tn), AROUND_STEP);
  return pn.applyAxisAngle(axis, step).multiplyScalar(Math.max(R, p.length()));
}

/** Over a sky station: the hold point's height over the deck's centre (m, + the station's size), and where it stops over the pad before settling (m). */
const SKY_HOLD = 200,
  PAD_ABOVE = 60;

/** Height above the pad it settles from (m), and the speed it settles at (m/s). */
const SETTLE_H = 9,
  SETTLE_V = 2;

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3(),
  qS = new THREE.Quaternion();

/** Engage for `st` (a pad already granted, or a unit that will ask for one itself). */
export function engageAutodock(g: Game, st: Station) {
  const unit = g.ship.avionics.dock;
  if (!unit || g.dock?.docked) return;
  g.ship.ap = null;
  g.ship.sunTrack = false;
  g.autodock = { phase: g.dock ? 'hold' : g.dockRequest ? 'wait' : 'approach' };
  g.autodockStation = st;
  // its reference, the ship's offset from the station, is otherwise only kept while it flies: fresh
  // now, or its first step works from a stale one (latched as the spot to wait at, it was near the
  // station's centre, and it flew at the station)
  g.dockRel.subVectors(g.ship.pos, st.pos);
  const how = g.dock ? `pad ${g.dock.pad + 1}` : g.dockRequest ? 'waiting for clearance' : 'will request clearance on approach';
  g.showMsg(`${unit.model} ${unit.name} · docking at ${st.name} · ${how} · thrust keys take over`);
}

/** After launch, fly out through the slot (WD-300 and up). */
export function engageAutoLaunch(g: Game, st: Station, pad: number) {
  const unit = g.ship.avionics.dock;
  if (!unit?.caps.launch) return;
  g.autodock = { phase: 'rise' };
  g.autodockStation = st;
  g.dockRel.subVectors(g.ship.pos, st.pos);
  g.autodockPad = pad;
}

export function stopAutodock(g: Game, why?: string) {
  if (!g.autodock) return;
  g.autodock = null;
  if (why) g.showMsg(why, 'warn');
}

/**
 * One step of the docking computer, in place of manual flight. `grav` is the local pull (the ship
 * and the station fall together, so it's applied but needs no correction).
 */
export function autodock(g: Game, dt: number, gravVec: THREE.Vector3) {
  const ad = g.autodock!;
  const { ship } = g;
  const unit = ship.avionics.dock!;
  const st = g.dock?.station ?? g.autodockStation;
  if (!st) return stopAutodock(g, 'Docking computer off · no station');
  // no pad yet: fly within range (WD-300), ask for one, and hold still until the answer comes
  if (!g.dock && ad.phase !== 'rise' && ad.phase !== 'exit') {
    const inRange = st.pos.distanceTo(ship.pos) < DOCK_REQUEST_RANGE * 0.95;
    if (g.dockRequest) ad.phase = 'wait';
    else if (inRange) {
      if (!unit.caps.clearance) return stopAutodock(g, 'Docking computer off · request a pad first (K)');
      requestDocking(g, st);
      ad.phase = 'wait';
    } else ad.phase = 'approach';
  } else if (ad.phase === 'wait' || ad.phase === 'approach') {
    ad.phase = 'hold'; // the pad came through
    ad.waitAt = undefined;
    g.showMsg(`Docking computer · to ${st.name}, pad ${g.dock!.pad + 1}`);
  }
  const d = g.dock;
  ship.vel.addScaledVector(gravVec, dt);

  const S = st.size;
  const q = stationQuat(st, g.simTime, qS);
  const qInv = q.clone().invert();
  // the ship in station coordinates (metres), from the end-of-step offset
  const rel = g.dockRel;
  const p = tmp.copy(rel).applyQuaternion(qInv);
  const toWorld = (local: THREE.Vector3) => local.clone().applyQuaternion(q);

  const padI = d?.pad ?? g.autodockPad;
  // (an open deck, over a world or parked in space) and, of those, one that hangs in a world's air and doesn't fall
  const sky = isDeck(st);
  const world = !!st.sky;
  // far out, fly the approach much faster (the braking profile still brings it in gently); in the
  // air, never faster than it allows
  const far = p.length() > APPROACH_NEAR;
  const farSpeed = world ? Math.min(FAR_SPEED, airSpeedLimit(airDensityAt(st.parent, ship.pos))) : FAR_SPEED;
  const pad = padOf(st, padI);
  const axisZ = pad.pos.z * S;
  let target = new THREE.Vector3(); // station coordinates, metres
  let cap = 0;
  // desired attitude: nose along −z_local (into the station) or +z (out), top along the slot's y
  // (lined up with the slot) or toward the axis (over the pad)
  let fwdL = new THREE.Vector3(0, 0, -1),
    upL = new THREE.Vector3(0, 1, 0);
  // The corridor (render/stationMesh.ts): CORRIDOR_M out along the axis from the slot. The ship
  // lines up at its mouth and flies it all the way in (it used to line up only HOLD_OUT from the
  // slot and cut in from the side); one already in it lines up where it is. `onLane`: in the
  // corridor, or on its line beyond the mouth, where the nose stays on the slot (pointing along its
  // way it turned round backing up to a queue spot, then back).
  const mouthZ = S / 2 + CORRIDOR_M;
  const laneR = (z: number) => S * 0.5 + 0.35 * Math.min(Math.max(0, z - S / 2), CORRIDOR_M);
  const onLane = !sky && p.z > S / 2 && Math.hypot(p.x, p.y) < laneR(p.z);
  if (ad.phase === 'hold' && ad.entryZ === undefined) ad.entryZ = onLane && p.z < mouthZ ? Math.max(p.z, S / 2 + HOLD_OUT) : mouthZ;
  const holdPt = sky ? new THREE.Vector3(deckCentre(st) * S, 0, S * 0.87 + SKY_HOLD) : new THREE.Vector3(0, 0, ad.entryZ ?? mouthZ);
  const overPad = pad.pos.clone().multiplyScalar(S).addScaledVector(pad.up, PAD_ABOVE);
  // traffic control (sim/control.ts): may this ship use the slot now? Arriving, only if it's free
  // and no one ahead of it in the queue; leaving, only if it's free
  const busy = slotUser(g, st);
  if (ad.phase === 'hold' && ad.waitSince === undefined) ad.waitSince = g.simTime;
  const slotTurn = sky || (!busy && (ad.phase !== 'hold' || queuePlace(g, st) === 0));
  switch (ad.phase) {
    case 'approach':
      // toward the hold point, until in range to ask for a pad: braking to arrive there nearly at
      // rest, since it then holds that spot while it waits (arriving at speed it braked on for km
      // past it, drifting in toward the station while it waited)
      target = holdPt;
      cap = Math.min(far ? farSpeed : unit.caps.approachSpeed, 20 + Math.sqrt(2 * BRAKE * Math.max(0, p.length() - DOCK_REQUEST_RANGE * 0.9)));
      break;
    case 'wait':
      // hold the spot it was at when it asked, against the station, while traffic control answers
      // (re-aiming at wherever it had got to each frame let it drift in; kept in world axes, since
      // a point fixed in the turning station off its axis would be flung round)
      if (!ad.waitAt) ad.waitAt = rel.clone();
      target = ad.waitAt.clone().applyQuaternion(qInv);
      cap = unit.caps.approachSpeed;
      break;
    case 'hold':
      // the slot busy (another ship in it, or ahead in the queue): wait on its axis, further out
      // the further back in the queue (sim/control.ts); clear and first: to the hold point
      target = slotTurn || sky ? holdPt : new THREE.Vector3(0, 0, mouthZ + (1 + queuePlace(g, st)) * SLOT_QUEUE);
      cap = far ? farSpeed : unit.caps.approachSpeed;
      fwdL = new THREE.Vector3(0, 0, -1);
      upL = new THREE.Vector3(0, 1, 0);
      break;
    case 'align':
      target = holdPt;
      cap = 10;
      fwdL = new THREE.Vector3(0, 0, -1);
      upL = new THREE.Vector3(0, 1, 0);
      break;
    case 'enter':
      target = sky ? overPad : new THREE.Vector3(0, 0, axisZ);
      // down the corridor at up to the approach speed, braking to the inside speed by the slot
      cap = sky ? unit.caps.insideSpeed : Math.min(unit.caps.approachSpeed, Math.sqrt(unit.caps.insideSpeed ** 2 + 2 * BRAKE * Math.max(0, p.z - S / 2 - 200)));
      fwdL = new THREE.Vector3(0, 0, -1);
      upL = new THREE.Vector3(0, 1, 0);
      break;
    case 'descend': {
      target = pad.pos.clone().multiplyScalar(S).addScaledVector(pad.up, SETTLE_H - 2.5); // just inside touchdown range
      cap = Math.min(unit.caps.insideSpeed, 25);
      fwdL = new THREE.Vector3(0, 0, 1);
      upL = pad.up.clone();
      break;
    }
    case 'rise':
      target = sky ? overPad : new THREE.Vector3(0, 0, axisZ);
      cap = Math.min(unit.caps.insideSpeed, 25);
      fwdL = new THREE.Vector3(0, 0, 1);
      upL = pad.up.clone();
      break;
    case 'exit':
      // out to the corridor's mouth (a sky deck: its hold point); faster once clear of the slot
      target = sky ? holdPt : new THREE.Vector3(0, 0, mouthZ);
      cap = !sky && p.z > S / 2 + 200 ? unit.caps.approachSpeed : unit.caps.insideSpeed;
      fwdL = new THREE.Vector3(0, 0, 1);
      upL = new THREE.Vector3(0, 1, 0);
      break;
  }
  // on a sky deck: upright, nose outward, all the way in and out
  if (sky) {
    fwdL = pad.fwd.clone();
    upL = pad.up.clone();
  }

  // outside the station, don't fly through it on the way to the hold point
  if (ad.phase === 'approach' || ad.phase === 'hold') target = clearPath(p, target, S);
  // guidance: along the straight line to the target at a speed we can always brake from, matched
  // to the station's structure at the ship (orbit + spin)
  const err = target.clone().sub(p);
  const dist = err.length();
  const brakeV = Math.sqrt(2 * BRAKE * dist);
  let speed = Math.min(cap, brakeV, dist / TAU);
  if (ad.phase === 'descend') {
    // settle gently: the closer to the pad (height above the hangar wall), the slower, down to
    // SETTLE_V at touchdown; a profile on the distance to the target point alone reached the pad at
    // ~14 m/s when the ship lagged its commanded speed
    const h = sky ? p.z : (HANGAR_R - Math.hypot(p.x, p.y) / S) * S; // (a deck's top is at z = 0)
    speed = Math.max(Math.min(speed, 12, SETTLE_V + 0.25 * Math.max(0, h - SETTLE_H)), dist > 1 ? SETTLE_V : 0);
  }
  const vDesL = dist > 1e-6 ? err.multiplyScalar(speed / dist) : err.set(0, 0, 0);
  // inside the hull match the turning structure; outside, just the station's orbit (the spin term
  // ω × r would be ~100 m/s a kilometre off the axis)
  const inHull = Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) < S / 2;
  // (a sky station turns with its world: slowly enough that ω × r is right everywhere near it)
  const vFrame = (inHull || sky ? stationPointVelAt(st, rel, tmp2) : tmp2.copy(st.vel)).sub(g.frameBody.vel);
  const vDes = toWorld(vDesL).add(vFrame);
  // close to the pad, correct twice as quickly so the ship doesn't lag its (slowing) commanded speed
  const T = vDes.sub(ship.vel).divideScalar(ad.phase === 'descend' ? TAU / 2 : TAU);
  // a sky station doesn't fall: hold the ship up with it (plus the pull that turns it with the world)
  if (world) T.add(stationAcc(st)).sub(gravVec);
  // Normally it keeps to AUTO_ACC. But taken over while closing fast (engaged 5 km out from a
  // rendezvous still braking for its 2 km stand-off at ~500 m/s, it needed 5.5 km to stop and hit
  // the hull at 300 m/s), it brakes as hard as it must to stop short of the hull, up to the drive's
  // limit (with a margin: 1.5× what it needs).
  let acc = AUTO_ACC;
  if (!inHull && !sky) {
    const out = rel.length();
    const closing = -ship.vel.clone().sub(vFrame).dot(rel) / Math.max(out, 1);
    const room = Math.max(1, out - (S * 0.87 + KEEP_OUT));
    if (closing > 0) acc = Math.min(NORMAL_ACC, Math.max(AUTO_ACC, (1.5 * closing * closing) / (2 * room)));
  }
  // waiting for clearance and still moving fast (handed over from a rendezvous at ~500 m/s): stop
  // hard, so the spot it holds is near where it asked (at AUTO_ACC it slid ~5 km on before stopping)
  if (ad.phase === 'wait' && ship.vel.clone().sub(vFrame).length() > 50) acc = Math.max(acc, WAIT_BRAKE);
  if (T.length() > acc) T.setLength(acc);
  T.multiplyScalar(dt);
  applyThrust(g, T, dt);
  ship.vel.add(T);

  // attitude: turn toward the wanted one (with the station's spin carried by rotation correction).
  // On the way to the hold point the nose points where it's going (at the station while waiting for
  // clearance), not strafing; only the last FACE_SLOT metres turn it to the slot's orientation.
  let fwdW: THREE.Vector3, upW: THREE.Vector3;
  const cruising = !onLane && (ad.phase === 'approach' || ad.phase === 'wait' || (ad.phase === 'hold' && dist > FACE_SLOT));
  if (cruising) {
    const way = ad.phase === 'wait' || target.distanceTo(p) < 1 ? p.clone().negate() : target.clone().sub(p);
    fwdW = toWorld(way).normalize();
    upW = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q); // keep the roll the ship has
    if (Math.abs(upW.dot(fwdW)) > 0.98) upW = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.q);
    upW.addScaledVector(fwdW, -upW.dot(fwdW)).normalize(); // square to the nose
  } else {
    fwdW = toWorld(fwdL);
    upW = toWorld(upL);
  }
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(upW, fwdW.clone().negate()).normalize(), upW, fwdW.clone().negate());
  const want = new THREE.Quaternion().setFromRotationMatrix(m);
  ship.q.rotateTowards(want, Math.max(0.6 * dt, ship.q.angleTo(want) * (1 - Math.exp(-2.5 * dt)))).normalize();
  const attErr = ship.q.angleTo(want);

  // relative speed against the structure, and phase changes
  const vRel = ship.vel.clone().sub(vFrame).length();
  const next = (ph: AutoPhase, msg: string) => {
    ad.phase = ph;
    ad.waitSince = undefined;
    ad.told = false;
    ad.waitAt = undefined;
    g.showMsg(`Docking computer · ${msg}`);
  };
  // told once when it has to wait for the slot
  if (busy && (ad.phase === 'hold' || ad.phase === 'rise') && !ad.told) {
    ad.told = true;
    g.showMsg(`Docking computer · holding for the slot · ${pilotName(g, busy)} is ${busy.autodock?.phase === 'exit' || busy.autodock?.phase === 'rise' ? 'coming out' : 'going in'}`);
  }
  if (ad.phase === 'hold' && slotTurn && dist < 40 && vRel < 6) next('align', 'lining up with the slot');
  else if (ad.phase === 'align' && dist < 40 && attErr < 0.03) next('enter', 'entering');
  else if (ad.phase === 'enter' && dist < 20 && vRel < 6) next('descend', `to pad ${padI + 1}`);
  else if (ad.phase === 'rise' && slotTurn && dist < 20 && vRel < 6) next('exit', 'leaving through the slot');
  else if (ad.phase === 'exit' && dist < 60) {
    g.autodock = null;
    g.showMsg(`Clear of ${st.name} · you have control`);
  }
}
