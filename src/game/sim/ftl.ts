import { FTL_CHARGE_TIME, FTL_MAX, NORMAL_MAX, REARTH, SHIP, ftlBurn } from '../constants';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Ship } from '../types';
import { apLabel } from './orbits';

/** How strongly a body's gravity well slows the FTL drive. */
export function wellFactor(b: Body) {
  return Math.min(12, Math.max(0.6, Math.sqrt(b.radius / REARTH)));
}

/** Altitude below which the FTL drive drops out. */
export function dropAlt(b: Body) {
  return b.kind === 'star' ? b.radius * 0.6 : Math.max(b.radius * 0.12, 30e3);
}

/** The body whose gravity well stops the FTL drive from starting, if any. */
export function massLock(g: Game) {
  for (const b of g.cur.bodies) {
    const alt = b.pos.distanceTo(g.ship.pos) - b.radius;
    if (alt < dropAlt(b) * 1.15) return b;
  }
  return null;
}

/** FTL speed limit from the nearby gravity wells. */
export function ftlSpeedLimit(g: Game) {
  let vmax = FTL_MAX;
  for (const b of g.cur.bodies) {
    const alt = Math.max(0, b.pos.distanceTo(g.ship.pos) - b.radius);
    vmax = Math.min(vmax, (alt / wellFactor(b)) * 0.9);
  }
  return Math.max(vmax, 2e4);
}

export function ftlBlocked(ship: Ship) {
  if (ship.exotic < SHIP.ftlChargeKg) return 'Not enough exotic matter to start the FTL drive';
  if (ship.batt < 6) return 'Battery too low to charge the FTL drive (needs 6 kWh)';
  return null;
}

/** Exotic matter and power while the FTL drive runs. Returns false if the drive fails. */
export function ftlUpkeep(g: Game, dt: number, load: number) {
  const { ship, power } = g;
  ship.exotic = Math.max(0, ship.exotic - ftlBurn(load) * dt);
  power.ftlKW = SHIP.ftlCruiseKW;
  let why: string | null = null;
  if (ship.exotic <= 0) why = 'Exotic matter exhausted';
  else if (ship.batt <= 0 && power.solar < SHIP.ftlCruiseKW + SHIP.baseLoad) why = 'Power failure';
  if (!why) return true;
  ship.ap = null;
  dropFTL(g, false);
  g.showMsg(`${why} · FTL drive offline`, 'warn');
  return false;
}

export function toggleFTL(g: Game) {
  const { ship } = g;
  if (g.jump) return;
  if (ship.mode === 'ftl') {
    dropFTL(g, false);
    return;
  }
  if (ship.ftlCharge > 0) {
    ship.ftlCharge = 0;
    g.showMsg('FTL charge cancelled');
    return;
  }
  const lock = massLock(g);
  if (lock) {
    g.showMsg(`Mass-locked by ${lock.name} · climb above ${fmtDist(dropAlt(lock) * 1.15)}`, 'warn');
    return;
  }
  const blocked = ftlBlocked(ship);
  if (blocked) {
    g.showMsg(blocked, 'warn');
    return;
  }
  ship.ftlCharge = FTL_CHARGE_TIME;
  g.showMsg('FTL drive charging', 'ftl');
}

export function engageFTL(g: Game) {
  const { ship } = g;
  const blocked = ftlBlocked(ship);
  if (blocked) {
    if (ship.ap) ship.ap.phase = 'insert';
    g.showMsg(blocked, 'warn');
    return;
  }
  ship.exotic -= SHIP.ftlChargeKg;
  ship.mode = 'ftl';
  ship.tanker = null;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
  ship.ftlSpeed = Math.max(ship.vel.dot(fwd), 0) + 3e4;
  ship.throttle = 0.3;
  ship.vel.set(0, 0, 0);
  ship.landed = null;
  if (ship.ap) {
    ship.ap.phase = 'transfer';
    g.showMsg(`Autopilot · FTL transfer to ${ship.ap.body.name}`, 'ftl');
    return;
  }
  g.showMsg('FTL engaged · W / S sets throttle', 'ftl');
}

export function dropFTL(g: Game, forced: boolean, body?: Body) {
  const { ship } = g;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
  ship.mode = 'normal';
  ship.vel.copy(fwd).multiplyScalar(forced ? 500 : Math.min(ship.ftlSpeed, NORMAL_MAX));
  ship.ftlSpeed = 0;
  if (ship.ap) {
    ship.ap.phase = 'insert';
    ship.vel.set(0, 0, 0);
    g.showMsg(`Autopilot · inserting into ${apLabel(ship.ap)}`, 'ftl');
    return;
  }
  if (forced && body) g.showMsg(`Emergency drop · too close to ${body.name}`, 'warn');
  else g.showMsg('Dropped to normal space');
}

/** Tick the FTL charge timer; engage when it runs out. */
export function chargeFTL(g: Game, dt: number) {
  const { ship } = g;
  if (ship.ftlCharge <= 0) return;
  ship.ftlCharge -= dt;
  if (ship.ftlCharge <= 0) {
    ship.ftlCharge = 0;
    if (!massLock(g)) engageFTL(g);
    else if (ship.ap) ship.ap.phase = 'insert';
    else g.showMsg('FTL aborted · mass-locked', 'warn');
  }
}

/** Manual FTL flight: W / S set the throttle, and the drive slows itself near massive bodies. */
export function ftlCruise(g: Game, dt: number) {
  const { ship, keys } = g;
  if (keys.KeyW) ship.throttle = Math.min(1, ship.throttle + 0.45 * dt);
  if (keys.KeyS) ship.throttle = Math.max(0, ship.throttle - 0.45 * dt);
  if (keys.KeyX) ship.throttle = 0;
  const vmax = ftlSpeedLimit(g);
  ship.vmax = vmax;
  const tgt = ship.throttle * vmax;
  if (ship.ftlSpeed < tgt) ship.ftlSpeed = Math.min(tgt, ship.ftlSpeed * Math.exp(1.5 * dt) + 20000 * dt);
  else ship.ftlSpeed = Math.max(tgt, ship.ftlSpeed * Math.exp(-2.5 * dt));
  ship.ftlSpeed = Math.min(ship.ftlSpeed, vmax);
  ship.pos.addScaledVector(g.fwd, ship.ftlSpeed * dt);
  g.curSpeed = ship.ftlSpeed;
  if (ftlUpkeep(g, dt, ship.throttle)) {
    for (const b of g.cur.bodies) {
      const alt = b.pos.distanceTo(ship.pos) - b.radius;
      if (alt < dropAlt(b)) {
        dropFTL(g, true, b);
        break;
      }
    }
  }
}
