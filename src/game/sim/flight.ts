import { impact } from './damage';
import { ARRIVE_FLUX, CRASH_SPEED, NORMAL_ACC, NORMAL_BOOST, NORMAL_MAX, RESPAWN_TIME, WT, fluxDist } from '../constants';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Gravity } from '../types';
import { frameVel, resetFrame, ringFrameOf } from './frame';
import { dominantBody } from './gravity';
import { dropAlt } from './ftl';
import { lookAt } from './navigation';
import { closePlanner, disengageAP } from './planner';
import { applyThrust, refillShip } from './resources';
import { stationLimits } from './docking';
import { TEMP } from './thermal';
import { altitudeAt, reliefAmp, surfaceRadius } from './terrain';
import { RING_HALF_THICK } from './rings';

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3(),
  tmp3 = new THREE.Vector3(),
  spinVel = new THREE.Vector3(),
  tmpAhead = new THREE.Vector3();

/** Near the ground flight assist caps your speed against it at SURF_K × height (m/s per m) … */
export const SURF_K = 0.2,
  /** … but never below this, so you can still land (well under CRASH_SPEED). */
  SURF_MIN = 8,
  /** Height the ship rests at above the terrain (collide). */
  CLEARANCE = 30;
/** A replacement ship is delivered at least this far (m) outside a ring's belt. */
const RESPAWN_RING_CLEAR = 50e3;
/** Touching down faster than this (m/s) damages the hull (sim/damage.ts). */
const LAND_SCRAPE = 10;

/**
 * Flight assist's speed limit near a world's surface, if it's lower than the normal one: SURF_K ×
 * height above the ground, so it tightens as you descend (from 4 km/s at 20 km to 8 m/s at the
 * ground) and you can't slam into the terrain with flight assist on. Null far from any surface.
 */
export function surfaceLimit(g: Game) {
  const b = g.ship.landed ?? g.frameBody;
  if (b.kind === 'star' || !reliefAmp(b)) return null;
  const lim = Math.max(SURF_MIN, (altitudeAt(b, g.ship.pos) - CLEARANCE) * SURF_K);
  return lim < NORMAL_MAX ? lim : null;
}

/** Inside a ring's belt, flight assist's speed limit (m/s; ×3 with boost): slow enough to pick a way among the rocks. */
export const BELT_MAX = 800;

/** Flight assist's speed limit in a ring's belt (sim/frame.ts ring frame), or null outside one. */
export function beltLimit(g: Game) {
  return g.ship.fa && ringFrameOf(g) ? BELT_MAX : null;
}

/** Manual flight. Gravity always acts. Flight assist damps drift on axes you are not
 *  thrusting on and holds your course against gravity while you thrust; hands-off near a
 *  body it leaves the velocity along the pull alone, so you fall unless you thrust away. Near a station it works relative to the station instead
 *  (see sim/frame.ts): you fall together, so it holds you still beside it. With flight
 *  assist off the ship is purely Newtonian.
 *  `inp` is the thrust input in ship axes: [right, up, back]. */
export function manualFlight(g: Game, dt: number, grav: Gravity, inp: number[]) {
  const { ship, keys } = g;
  // inside a station: docking thrusters, and a speed limit that eases you onto the pad (sim/docking.ts)
  const inside = ship.fa ? stationLimits(g) : null;
  const boost = !inside && (keys.ShiftLeft || keys.ShiftRight);
  const surf = inside || !ship.fa ? null : surfaceLimit(g);
  const belt = inside || surf !== null ? null : beltLimit(g);
  const acc = inside ? inside.acc : boost ? NORMAL_ACC * 3 : NORMAL_ACC,
    maxV = inside ? inside.maxV : surf !== null ? surf * (boost ? 3 : 1) : belt !== null ? belt * (boost ? 3 : 1) : boost ? NORMAL_BOOST : NORMAL_MAX;
  ship.vel.addScaledVector(grav.vec, dt);
  // everything below works in the local frame: the station's, or the system's. Its velocity is
  // taken where this step leaves the ship (pos + vel·dt), not where it is: in a turning frame (the
  // belt's rocks, the ground) the frame's velocity changes with position, and the gravity just
  // added is this step's (dt) while the move from the last position was the last step's. Taken
  // here, the two differed by a·(dt − dt_prev) every frame: with a jittery frame rate in a giant's
  // belt (a ≈ 2.7 m/s²) flight assist burned up to ~1 kg/s "holding still" against nothing. Hands
  // off (flight assist off) nothing fired and nothing drifted, which gave it away.
  tmpAhead.copy(ship.pos);
  ship.pos.addScaledVector(ship.vel, dt);
  const fv = frameVel(g);
  ship.pos.copy(tmpAhead);
  const v0 = ship.vel.clone().sub(fv);

  const gh = tmp.copy(grav.vec).normalize();
  const stopping = keys.KeyX && !ship.ap; // the autopilot ignores manual input
  // How much of the pull flight assist ignores: none in deep space, all of it near a body while
  // you're hands-off (so an idle ship falls), none in a station's frame (the station falls with
  // you). While you're thrusting it ignores none of it: it holds your course against gravity, so
  // the travel direction stays on the nose instead of sagging toward the planet (it drifted ~36°
  // off when flying across a planet's pull toward its moon).
  const flying = inp[0] !== 0 || inp[1] !== 0 || inp[2] !== 0;
  // (in a ring's belt, none either: you and the rocks orbit together, so it holds you among them)
  const w = stopping || g.refFrame || flying || ringFrameOf(g) ? 0 : Math.min(1, Math.max(0, (grav.g - 0.02) / 0.3));
  const radial = gh.clone().multiplyScalar(v0.dot(gh) * w);
  const rest = v0.clone().sub(radial);
  const lv = rest.clone().applyQuaternion(g.qInv);
  const arr = [lv.x, lv.y, lv.z];
  for (let c = 0; c < 3; c++) {
    if (stopping) {
      arr[c] -= Math.sign(arr[c]) * Math.min(Math.abs(arr[c]), (inside ? acc : NORMAL_ACC * 3) * dt);
      continue;
    }
    if (inp[c] !== 0) arr[c] += inp[c] * acc * dt;
    // decoupled: no damping, so you keep drifting whichever way the nose points; nor while the
    // collision radar nudges you clear of a rock (sim/belt.ts)
    else if (ship.fa && !ship.decoupled && !g.nudging) arr[c] -= Math.sign(arr[c]) * Math.min(Math.abs(arr[c]), acc * 0.7 * dt);
  }
  lv.set(arr[0], arr[1], arr[2]);
  // after a boost, flight assist bleeds speed back down to the normal limit
  const sp = lv.length();
  if (ship.fa && !boost && sp > maxV) lv.setLength(Math.max(maxV, sp - (inside ? acc * 2 : NORMAL_ACC * 4) * dt));
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
  // near the surface the limit covers falling too (hands off, the pull isn't otherwise damped), so
  // the ship eases down onto the ground instead of hitting it
  if (surf !== null) {
    const v1 = tmp3.copy(v0).add(T);
    const sp1 = v1.length();
    if (sp1 > maxV) {
      const cut = Math.min(sp1 - maxV, NORMAL_ACC * 4 * dt);
      T.addScaledVector(v1, -cut / sp1);
    }
  }
  applyThrust(g, T, dt);
  ship.vel.copy(v0).add(T).add(fv);
  if (inp[0] || inp[1] || inp[2]) ship.landed = null;
}

/**
 * Surface contact with the terrain (sim/terrain.ts): gentle touchdown lands you, anything faster is
 * a crash. On the ground the ship turns with the world, so it stays put on the spinning surface.
 */
export function collide(g: Game, dt: number) {
  const { ship } = g;
  for (const b of g.cur.bodies) {
    const rel = tmp.subVectors(ship.pos, b.pos);
    const d = rel.length();
    // cheap reject before sampling the terrain: above the highest peaks
    if (d > b.radius * 1.01 + 200 && ship.landed !== b) continue;
    const min = surfaceRadius(b, ship.pos) + CLEARANCE;
    if (d >= min) {
      if (ship.landed === b && d > min + 20) ship.landed = null;
      continue;
    }
    rel.divideScalar(d);
    // work in the ground's frame: the body's motion (it may not be the frame body) plus its spin
    const bv = tmp2.subVectors(b.vel, g.frameBody.vel);
    if (b.kind !== 'star') bv.add(spinVel.copy(b.axis).multiplyScalar(b.spin).cross(tmp3.copy(rel).multiplyScalar(d)));
    ship.vel.sub(bv);
    const vin = -ship.vel.dot(rel);
    if (b.kind === 'star') {
      ship.vel.add(bv);
      destroyShip(g, `Burned up in the photosphere of ${b.name}`, b);
      return;
    }
    if (b.type >= WT.GasGiant) {
      ship.vel.add(bv);
      destroyShip(g, `Crushed in the atmosphere of ${b.name} · gas giants have no surface`, b);
      return;
    }
    // a hard landing damages the hull, the harder the worse: a whole hull's worth at CRASH_SPEED
    const h0 = ship.hull;
    if (impact(g, vin, LAND_SCRAPE, CRASH_SPEED, b.name, b)) {
      ship.vel.add(bv);
      return;
    }
    ship.pos.copy(b.pos).addScaledVector(rel, min);
    if (vin > 0) ship.vel.addScaledVector(rel, vin);
    // ground friction
    const vtan = ship.vel.clone().addScaledVector(rel, -ship.vel.dot(rel));
    ship.vel.addScaledVector(vtan, -Math.min(1, 4 * dt)).add(bv);
    if (ship.ap) disengageAP(g);
    if (ship.landed !== b) {
      ship.landed = b;
      if (ship.hull >= h0 - 0.01) g.showMsg(`Touchdown on ${b.name} · ${vin.toFixed(0)} m/s`); // (else the damage report stands)
    }
  }
}

export function destroyShip(g: Game, reason: string, body: Body) {
  const { ship } = g;
  ship.dead = { t: RESPAWN_TIME, reason, body };
  g.dock = null;
  g.dockRequest = null;
  g.inStation = null;
  g.ascent = null;
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
  const alt = b.kind === 'star' ? fluxDist(b.L, ARRIVE_FLUX, b.radius) - b.radius : Math.max(dropAlt(b) * 2, b.radius * 1.5);
  ship.pos.copy(b.pos).addScaledVector(u, b.radius + alt);
  // never inside a ring's belt: at rest there the rocks stream past at km/s, and a replacement ship
  // delivered where the last one hit a rock was hit again and again. Lifted clear of its slab.
  if (b.kind !== 'star' && b.ring) {
    const rel = ship.pos.clone().sub(b.pos);
    const h = rel.dot(b.axis);
    const r = Math.sqrt(Math.max(0, rel.lengthSq() - h * h));
    const clear = RING_HALF_THICK + RESPAWN_RING_CLEAR;
    if (r > b.ring.inner * b.radius - RESPAWN_RING_CLEAR && r < b.ring.outer * b.radius + RESPAWN_RING_CLEAR && Math.abs(h) < clear)
      ship.pos.addScaledVector(b.axis, (h >= 0 ? 1 : -1) * clear - h);
  }
  ship.vel.set(0, 0, 0);
  resetFrame(g, dominantBody(g.cur, ship.pos));
  ship.vel.copy(b.vel).sub(g.frameBody.vel); // at rest relative to the body you died at
  ship.mode = 'normal';
  ship.fa = true;
  ship.sunTrack = false;
  ship.tanker = null;
  refillShip(g);
  ship.temp = TEMP.start;
  ship.hull = 1;
  ship.vent = false; // the replacement comes with the same modules, stowed
  ship.outfit.deploy = false;
  ship.outfit.radiatorsOut = 0;
  lookAt(ship, b.pos);
  ship.dead = null;
  g.showMsg(`Replacement ship delivered ${fmtDist(alt)} above ${b.name} · tanks full`);
}
