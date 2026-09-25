import { JUMP_TUNNEL_TIME, SHIP } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot, ftlTransfer } from './autopilot';
import { collide, manualFlight, respawn } from './flight';
import { chargeFTL, ftlCruise } from './ftl';
import { gravityAt } from './gravity';
import { updateGuide } from './guide';
import { arriveAt } from './navigation';
import { disengageAP } from './planner';
import { refillShip, scoop, solarPower } from './resources';

const qa = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0),
  AY = new THREE.Vector3(0, 1, 0),
  AZ = new THREE.Vector3(0, 0, 1);
const MOUSE_SENS = 0.0021;

/** Advance the simulation by dt seconds. */
export function update(g: Game, dt: number) {
  const { ship, keys, power, input } = g;
  g.simTime += dt;
  const inTunnel = !!g.jump && g.jump.phase === 'tunnel';

  if (ship.dead) {
    ship.dead.t -= dt;
    updateGuide(g, dt);
    if (ship.dead.t <= 0) respawn(g);
    input.consumeMouse();
    ship.grav = gravityAt(g.cur, ship.pos);
    g.curSpeed = 0;
    return;
  }
  const apSteering = !!ship.ap && ship.ap.phase === 'transfer';

  // --- rotation
  const [mdx, mdy] = input.consumeMouse();
  if (!inTunnel && !apSteering) {
    let pitch = -mdy * MOUSE_SENS,
      yaw = -mdx * MOUSE_SENS,
      roll = 0;
    const kr = ship.mode === 'ftl' ? 0.8 : 1.1;
    if (keys.ArrowUp) pitch += kr * dt;
    if (keys.ArrowDown) pitch -= kr * dt;
    if (keys.ArrowLeft) yaw += kr * dt;
    if (keys.ArrowRight) yaw -= kr * dt;
    if (keys.KeyQ) roll += 1.4 * dt;
    if (keys.KeyE) roll -= 1.4 * dt;
    if (ship.sunTrack && (pitch || yaw || roll)) {
      ship.sunTrack = false;
      g.showMsg('Sun tracking off · manual steering');
    }
    ship.q.multiply(qa.setFromAxisAngle(AY, yaw)).multiply(qa.setFromAxisAngle(AX, pitch)).multiply(qa.setFromAxisAngle(AZ, roll)).normalize();
  }
  g.qInv.copy(ship.q).invert();
  g.fwd.set(0, 0, -1).applyQuaternion(ship.q);

  // --- charging and hyperjumps
  chargeFTL(g, dt);
  updateJump(g, dt);

  // --- planet spin
  for (const b of g.cur.bodies) b.rot += b.spin * dt;

  // --- movement
  const down = keys.ControlLeft || keys.ControlRight || keys.KeyC;
  const inp = [(keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), (keys.Space ? 1 : 0) - (down ? 1 : 0), (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0)];
  const anyInput = inp[0] || inp[1] || inp[2] || keys.KeyX;
  if (ship.ap && anyInput) disengageAP(g, 'Autopilot off · manual control');

  if (!inTunnel) {
    if (ship.mode === 'normal') {
      const grav = (ship.grav = gravityAt(g.cur, ship.pos));
      if (ship.ap && ship.ap.phase === 'insert') autopilot(g, dt, grav);
      else manualFlight(g, dt, grav, inp);
      ship.pos.addScaledVector(ship.vel, dt);
      collide(g, dt);
      g.curSpeed = ship.vel.length();
    } else if (apSteering) {
      ftlTransfer(g, dt);
    } else {
      ftlCruise(g, dt);
    }
  }

  if (ship.mode === 'ftl') ship.grav = gravityAt(g.cur, ship.pos);

  // --- power, fuel, refuelling
  if (ship.sunTrack && !apSteering && !inTunnel) {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
    const toS = g.cur.star.pos.clone().sub(ship.pos).normalize();
    const dq = new THREE.Quaternion().setFromUnitVectors(up, toS);
    ship.q.slerp(dq.multiply(ship.q), Math.min(1, 1.2 * dt)).normalize();
  }
  if (g.jump && g.jump.phase === 'charge') power.chargeKW = SHIP.jumpChargeKW;
  else if (ship.ftlCharge > 0) power.chargeKW = SHIP.ftlChargeKW;
  power.solar = inTunnel ? 0 : solarPower(g);
  power.draw = SHIP.baseLoad + power.thrustKW + power.ftlKW + power.chargeKW;
  power.net = power.solar - power.draw;
  ship.batt = Math.min(SHIP.battCap, Math.max(0, ship.batt + (power.net * dt) / 3600));
  if (ship.batt > 1) g.warned.batt = false;
  ship.burnRate += (power.burn / dt - ship.burnRate) * Math.min(1, dt * 3);
  power.thrustKW = power.ftlKW = power.chargeKW = power.burn = 0;
  if (!inTunnel) scoop(g, dt);
  updateTanker(g, dt);
  updateGuide(g, dt);

  // --- nearest body
  g.nearest = null;
  g.nearestAlt = Infinity;
  for (const b of g.cur.bodies) {
    const alt = b.pos.distanceTo(ship.pos) - b.radius;
    if (alt < g.nearestAlt) {
      g.nearestAlt = alt;
      g.nearest = b;
    }
  }

  if (g.msg.t > 0) {
    g.msg.t -= dt;
    if (g.msg.t <= 0) g.msg.on = false;
  }
  if (g.flash > 0) g.flash = Math.max(0, g.flash - dt * 1.4);
}

function updateJump(g: Game, dt: number) {
  const { jump, ship } = g;
  if (!jump) return;
  jump.t -= dt;
  if (jump.phase === 'charge' && jump.t <= 0) {
    jump.phase = 'tunnel';
    jump.t = JUMP_TUNNEL_TIME;
    ship.exotic = Math.max(0, ship.exotic - jump.cost);
    g.showMsg(`Hyperspace · ${jump.dest.name} · ${jump.cost.toFixed(1)} kg exotic matter used`, 'ftl');
  } else if (jump.phase === 'tunnel') {
    if (!jump.loaded && jump.t < 3.8) {
      jump.loaded = true;
      arriveAt(g, jump.dest);
    }
    if (jump.t <= 0) {
      g.flash = 1;
      const s = g.cur.sys.star;
      g.showMsg(`Arrived at ${g.cur.sys.name} · ${s.spec} · throttle up with W`, 'ftl');
      g.jump = null;
    }
  }
}

function updateTanker(g: Game, dt: number) {
  const { ship } = g;
  if (!ship.tanker) return;
  if (ship.mode !== 'normal' || g.curSpeed > 200) {
    ship.tanker = null;
    g.showMsg('Tanker rendezvous cancelled · hold still below 200 m/s', 'warn');
  } else if ((ship.tanker.t -= dt) <= 0) {
    ship.tanker.docked = true;
    ship.tanker = null;
    refillShip(g);
    g.showMsg('Tanker docked · all tanks and the battery are full');
  }
}
