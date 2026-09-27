/*
 * Docking computer (avionics kind 'dock'): it flies the ship in the way a careful pilot would
 * (sim/docking.ts has the manual procedure). The WD-100 takes over once you've been granted a pad
 * (K); the WD-300 can be engaged from 50 km out with K, flies toward the station, and asks for a
 * pad itself on reaching DOCK_REQUEST_RANGE.
 *
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
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Station } from '../types';
import { DOCK_REQUEST_RANGE, requestPad } from './docking';
import { applyThrust } from './resources';
import { HANGAR_R, padLocal, stationPointVelAt, stationQuat } from './stationGeom';

export type AutoPhase = 'hold' | 'align' | 'enter' | 'descend' | 'rise' | 'exit';

/** How far out on the axis the approach holds before going in (m). */
const HOLD_OUT = 600;
/** Beyond this from the station (m) the approach may go up to FAR_SPEED (m/s). */
const APPROACH_NEAR = 3000,
  FAR_SPEED = 1500;
/** Thrust the computer allows itself (m/s²), and how quickly it corrects velocity (s). */
const AUTO_ACC = 25,
  TAU = 0.6;
/** Braking it plans with (m/s²): well under AUTO_ACC so it always has margin. */
const BRAKE = 8;
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
  g.autodock = { phase: 'hold' };
  g.autodockStation = st;
  const how = g.dock ? `pad ${g.dock.pad + 1}` : 'will request clearance on approach';
  g.showMsg(`${unit.model} ${unit.name} · docking at ${st.name} · ${how} · thrust keys take over`);
}

/** After launch, fly out through the slot (WD-300 and up). */
export function engageAutoLaunch(g: Game, st: Station, pad: number) {
  const unit = g.ship.avionics.dock;
  if (!unit?.caps.launch) return;
  g.autodock = { phase: 'rise' };
  g.autodockStation = st;
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
  // no pad yet: the WD-300 asks for one once it's in range; without one it can't go in
  if (!g.dock && ad.phase !== 'rise' && ad.phase !== 'exit') {
    if (st.pos.distanceTo(ship.pos) < DOCK_REQUEST_RANGE) {
      if (!unit.caps.clearance) return stopAutodock(g, 'Docking computer off · request a pad first (K)');
      requestPad(g, st, `Docking computer · clearance granted · ${st.name} · pad`);
    } else if (ad.phase !== 'hold') return stopAutodock(g, 'Docking computer off · no pad');
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
  // far out, fly the approach much faster (the braking profile still brings it in gently)
  const far = p.length() > APPROACH_NEAR;
  const pad = padLocal(padI);
  const axisZ = pad.pos.z * S;
  let target = new THREE.Vector3(); // station coordinates, metres
  let cap = 0;
  // desired attitude: nose along −z_local (into the station) or +z (out), top along the slot's y
  // (lined up with the slot) or toward the axis (over the pad)
  let fwdL = new THREE.Vector3(0, 0, -1),
    upL = new THREE.Vector3(0, 1, 0);
  const holdPt = new THREE.Vector3(0, 0, S / 2 + HOLD_OUT);
  switch (ad.phase) {
    case 'hold':
      target = holdPt;
      cap = far ? FAR_SPEED : unit.caps.approachSpeed;
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
      target = new THREE.Vector3(0, 0, axisZ);
      cap = unit.caps.insideSpeed;
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
      target = new THREE.Vector3(0, 0, axisZ);
      cap = Math.min(unit.caps.insideSpeed, 25);
      fwdL = new THREE.Vector3(0, 0, 1);
      upL = pad.up.clone();
      break;
    case 'exit':
      target = holdPt;
      cap = unit.caps.insideSpeed;
      fwdL = new THREE.Vector3(0, 0, 1);
      upL = new THREE.Vector3(0, 1, 0);
      break;
  }

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
    const h = (HANGAR_R - Math.hypot(p.x, p.y) / S) * S;
    speed = Math.max(Math.min(speed, 12, SETTLE_V + 0.25 * Math.max(0, h - SETTLE_H)), dist > 1 ? SETTLE_V : 0);
  }
  const vDesL = dist > 1e-6 ? err.multiplyScalar(speed / dist) : err.set(0, 0, 0);
  // inside the hull match the turning structure; outside, just the station's orbit (the spin term
  // ω × r would be ~100 m/s a kilometre off the axis)
  const inHull = Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) < S / 2;
  const vFrame = (inHull ? stationPointVelAt(st, rel, tmp2) : tmp2.copy(st.vel)).sub(g.frameBody.vel);
  const vDes = toWorld(vDesL).add(vFrame);
  // close to the pad, correct twice as quickly so the ship doesn't lag its (slowing) commanded speed
  const T = vDes.sub(ship.vel).divideScalar(ad.phase === 'descend' ? TAU / 2 : TAU);
  if (T.length() > AUTO_ACC) T.setLength(AUTO_ACC);
  T.multiplyScalar(dt);
  applyThrust(g, T, dt);
  ship.vel.add(T);

  // attitude: turn toward the wanted one (with the station's spin carried by rotation correction)
  const fwdW = toWorld(fwdL),
    upW = toWorld(upL);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(upW, fwdW.clone().negate()).normalize(), upW, fwdW.clone().negate());
  const want = new THREE.Quaternion().setFromRotationMatrix(m);
  ship.q.rotateTowards(want, Math.max(0.6 * dt, ship.q.angleTo(want) * (1 - Math.exp(-2.5 * dt)))).normalize();
  const attErr = ship.q.angleTo(want);

  // relative speed against the structure, and phase changes
  const vRel = ship.vel.clone().sub(vFrame).length();
  const next = (ph: AutoPhase, msg: string) => {
    ad.phase = ph;
    g.showMsg(`Docking computer · ${msg}`);
  };
  if (ad.phase === 'hold' && dist < 40 && vRel < 6) next('align', 'lining up with the slot');
  else if (ad.phase === 'align' && dist < 40 && attErr < 0.03) next('enter', 'entering');
  else if (ad.phase === 'enter' && dist < 20 && vRel < 6) next('descend', `to pad ${padI + 1}`);
  else if (ad.phase === 'rise' && dist < 20 && vRel < 6) next('exit', 'leaving through the slot');
  else if (ad.phase === 'exit' && dist < 60) {
    g.autodock = null;
    g.showMsg(`Clear of ${st.name} · you have control`);
  }
}
