/*
 * The sky station catapult (docs/docking.md): instead of lifting off a sky station's pad yourself,
 * you can have it throw you straight up, and an ascent program flies you out of the air with no
 * input from you.
 *
 * Why not just throw you hard enough to coast out? At 10–20 km the air is still thick: the ship
 * (~113 m² nose-on, ~150 t) sheds half its speed to drag on the way up, so coasting clear of an
 * Earth-like atmosphere would need ~3 km/s at the pad, and at that speed in that air the hull takes
 * hundreds of MW of entry heating. Rockets have the same problem and the same answer: climb no
 * faster than the air allows (a cap on dynamic pressure, "max Q"), then go faster as it thins.
 *
 *   1. The catapult: a free kick straight up (no propellant), to the fastest the air at the deck
 *      allows (airSpeedLimit) — several hundred m/s over dense worlds, more over thin ones.
 *   2. The ascent program: holds the climb at the air's speed limit, thrusting against gravity and
 *      drag, nose along the way up; once above the top of the air it hands back control, still
 *      climbing at ASCENT_TOP_V.
 *
 * Any thrust key takes over. Traffic (sim/traffic.ts) leaves sky stations this way too.
 */
import { AP_ACC } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Gravity, Station, World } from '../types';
import { atmoOf, density } from './atmosphere';
import { applyThrust, shipMass } from './resources';
import { padOf, stationQuat } from './stationGeom';
import { crossSection } from './thermal';

/** Dynamic pressure the climb is held under (Pa): about a rocket's max Q. */
const MAX_Q = 30e3;
/** Entry heating the climb is held under (W): the hull sheds this without climbing toward TEMP.warn for long. */
const MAX_HEAT = 20e6;
/** The climb never goes faster than this (m/s), and leaves the air at it. */
export const ASCENT_TOP_V = 1500;
/** How quickly the program corrects the climb rate (s). */
const TAU = 1.5;

/** Mirrors sim/atmosphere.ts (entry heating ∝ √(ρ / nose radius) · v³ · A). */
const SG_K = 1.7415e-4,
  NOSE_R = 0.6;
/** The ship's cross-section nose-on (m², sim/thermal.ts HULL.endArea). */
const NOSE_AREA = 113;

/**
 * The fastest the ship should climb through air of density `rho` (kg/m³), nose first: under MAX_Q,
 * under MAX_HEAT, and under ASCENT_TOP_V.
 */
export function airSpeedLimit(rho: number) {
  if (rho <= 0) return ASCENT_TOP_V;
  const vq = Math.sqrt((2 * MAX_Q) / rho);
  const vh = Math.cbrt(MAX_HEAT / (SG_K * Math.sqrt(rho / NOSE_R) * NOSE_AREA));
  return Math.min(ASCENT_TOP_V, vq, vh);
}

/** The air's density (kg/m³) at a point over world `b`, or 0 without air. */
export function airDensityAt(b: World, pos: THREE.Vector3) {
  const a = atmoOf(b);
  return a ? density(a, pos.distanceTo(b.pos) - b.radius) : 0;
}

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3(),
  tmp3 = new THREE.Vector3();

/** Docked at a sky station: be thrown off the pad and flown out of the air. */
export function catapultLaunch(g: Game) {
  const d = g.dock;
  if (!d?.docked) return;
  const st = d.station;
  if (!st.sky) {
    g.showMsg('No catapult here · orbital stations launch you off the pad', 'warn');
    return;
  }
  const b = st.parent;
  const up = padOf(st, d.pad).up.applyQuaternion(stationQuat(st, g.simTime));
  const v0 = airSpeedLimit(airDensityAt(b, g.ship.pos));
  g.ship.vel.addScaledVector(up, v0);
  g.dock = null;
  g.autodock = null;
  g.ascent = { station: st, body: b };
  g.showMsg(`Catapult · ${st.name} · ${v0.toFixed(0)} m/s up · ascent program flying you out of the air · thrust keys take over`);
  g.invalidateHud();
}

export function stopAscent(g: Game, why: string, kind: '' | 'warn' = '') {
  g.ascent = null;
  g.showMsg(why, kind);
}

/**
 * One step of the ascent program, in place of manual flight: straight up at the air's speed limit,
 * with the drift across the ground trimmed to zero (you leave with the world's turn, as you were on
 * the deck).
 */
export function ascent(g: Game, dt: number, grav: Gravity) {
  const { ship } = g;
  const b = g.ascent!.body;
  const a = atmoOf(b);
  const rel = tmp.subVectors(ship.pos, b.pos);
  const r = rel.length();
  const up = rel.divideScalar(r);
  if (!a || r - b.radius > a.top) {
    stopAscent(g, `Clear of ${b.name}'s atmosphere · climbing at ${velUp(g, b, up).toFixed(0)} m/s · you have control`);
    return false;
  }
  const rho = density(a, r - b.radius);
  // the air turns with the world: work relative to it (that's what drag works on)
  const air = tmp2.copy(b.axis).multiplyScalar(b.spin).cross(tmp3.subVectors(ship.pos, b.pos)).add(b.vel).sub(g.frameBody.vel);
  const vAir = tmp3.subVectors(ship.vel, air);
  const vDes = up.clone().multiplyScalar(airSpeedLimit(rho));
  // feed forward: gravity, and the drag the air will take off the climb this step
  const mass = shipMass(ship);
  const drag = (rho * vAir.lengthSq() * 1 * crossSection(g, up)) / (2 * mass);
  const acc = vDes.sub(vAir).divideScalar(TAU).sub(grav.vec).addScaledVector(up, drag);
  if (acc.length() > AP_ACC) acc.setLength(AP_ACC);
  ship.vel.addScaledVector(grav.vec, dt);
  const T = acc.multiplyScalar(dt);
  applyThrust(g, T, dt);
  ship.vel.add(T);
  // nose up, along the climb (keeping the roll it has)
  const fwd = up;
  let top = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
  if (Math.abs(top.dot(fwd)) > 0.98) top = new THREE.Vector3(0, 0, 1).applyQuaternion(ship.q);
  top.addScaledVector(fwd, -top.dot(fwd)).normalize();
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(top, fwd.clone().negate()).normalize(), top, fwd.clone().negate());
  const want = new THREE.Quaternion().setFromRotationMatrix(m);
  ship.q.rotateTowards(want, 1.2 * dt).normalize();
  return true;
}

/** Climb rate (m/s) relative to world `b`. */
function velUp(g: Game, b: World, up: THREE.Vector3) {
  return tmp2.copy(g.ship.vel).add(g.frameBody.vel).sub(b.vel).dot(up);
}

/** For Game: the ascent program's state. */
export interface Ascent {
  station: Station;
  body: World;
}
