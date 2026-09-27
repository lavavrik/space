import { FTL_CHARGE_TIME, FTL_MAX, NORMAL_MAX, REARTH, SHIP, ftlBurn } from '../constants';
import { grant } from './power';
import { heatBlocked } from './thermal';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Ship } from '../types';
import { FRAME_ENTER, stationVel, stationWithin } from './frame';
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
  return heatBlocked(ship.temp);
}

/** Seconds the FTL drive can run short of power before it drops out. */
const FTL_BROWNOUT = 0.5;

/** Exotic matter and power while the FTL drive runs. Returns false if the drive fails. */
export function ftlUpkeep(g: Game, dt: number, load: number) {
  const { ship, power } = g;
  ship.exotic = Math.max(0, ship.exotic - ftlBurn(load) * dt);
  power.ftlKW = grant(g, SHIP.ftlCruiseKW, 'FTL drive');
  // the drive rides out a brief brownout on its own field; short for longer than this, it fails
  power.ftlShort = power.ftlKW < SHIP.ftlCruiseKW * 0.999 ? power.ftlShort + dt : 0;
  let why: string | null = null;
  if (ship.exotic <= 0) why = 'Exotic matter exhausted';
  else if (power.ftlShort > FTL_BROWNOUT) why = 'Power failure';
  if (!why) return true;
  ship.ap = null;
  dropFTL(g, false);
  g.showMsg(`${why} · FTL drive offline`, 'warn');
  return false;
}

/**
 * Decoupled flight (V). Rotation no longer steers: in FTL the drive keeps pushing along its last
 * direction, and in normal space flight assist stops damping your velocity, so you keep drifting
 * the way you were going. Turn 180° and you fly backwards; thrust still works along the ship's
 * axes, and X still brings you to a stop.
 */
export function toggleDecoupled(g: Game) {
  const { ship } = g;
  ship.decoupled = !ship.decoupled;
  if (!ship.decoupled) ship.travelDir.set(0, 0, -1).applyQuaternion(ship.q);
  g.showMsg(ship.decoupled ? 'Decoupled · turn freely, you keep your heading' : ship.mode === 'ftl' ? 'Coupled · the FTL drive follows the nose again' : 'Coupled · flight assist damps drift again');
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
  ship.travelDir.copy(fwd); // the drive always spins up along the nose
  ship.ftlSpeed = Math.max(ship.vel.dot(fwd), 0) + 3e4;
  ship.throttle = 0.3;
  ship.vel.set(0, 0, 0);
  ship.landed = null;
  if (ship.ap) {
    ship.ap.phase = 'transfer';
    g.showMsg(`Autopilot · FTL transfer to ${ship.ap.body.name}`, 'ftl');
    return;
  }
  g.showMsg(ship.cruise ? 'FTL engaged · cruise control on · W / S set the throttle' : 'FTL engaged · hold W to accelerate · F for cruise control', 'ftl');
}

export function dropFTL(g: Game, forced: boolean, body?: Body) {
  const { ship } = g;
  ship.mode = 'normal';
  // keep moving the way the drive was pushing, which may not be where the nose points
  ship.vel.copy(ship.travelDir).multiplyScalar(forced ? 500 : Math.min(ship.ftlSpeed, NORMAL_MAX));
  ship.ftlSpeed = 0;
  if (ship.ap) {
    ship.ap.phase = 'insert';
    ship.vel.set(0, 0, 0);
    g.showMsg(`Autopilot · inserting into ${apLabel(ship.ap)}`, 'ftl');
    return;
  }
  if (forced && body) g.showMsg(`Emergency drop · too close to ${body.name}`, 'warn');
  else {
    // dropping out beside a station puts you straight into its frame, moving with it
    const st = stationWithin(g, FRAME_ENTER);
    if (st) {
      ship.vel.add(stationVel(g, st));
      g.refFrame = st;
      g.showMsg(`Dropped to normal space · matched ${st.name}'s orbit`);
    } else g.showMsg('Dropped to normal space');
  }
}

/** Tick the FTL charge timer; engage when it runs out. */
export function chargeFTL(g: Game, dt: number) {
  const { ship } = g;
  if (ship.ftlCharge <= 0) return;
  // a fixed energy (6 MW × 3 s = 5 kWh): at less than full power it takes longer
  const kw = grant(g, SHIP.ftlChargeKW, 'FTL charging');
  g.power.chargeKW = kw;
  ship.ftlCharge -= (dt * kw) / SHIP.ftlChargeKW;
  if (ship.ftlCharge <= 0) {
    ship.ftlCharge = 0;
    // charged: hand this frame's charging power back so the drive can run on it straight away
    // (without this the drive started with nothing left this frame and failed at once)
    g.power.left += kw;
    g.power.chargeKW = 0;
    g.power.ftlShort = 0;
    if (!massLock(g)) engageFTL(g);
    else if (ship.ap) ship.ap.phase = 'insert';
    else g.showMsg('FTL aborted · mass-locked', 'warn');
  }
}

/** Throttle lost per second with cruise control off and W released: from full to idle in ~6 s. */
const SPOOL_DOWN = 0.17;
/** With cruise off, the drive drops out once the throttle is idle and it has slowed below this. */
const SPOOL_DROP_SPEED = 5e4; // m/s

/** Cruise control (F): hold the FTL throttle where it is instead of letting it spool down. */
export function toggleCruise(g: Game) {
  const { ship } = g;
  ship.cruise = !ship.cruise;
  g.showMsg(ship.cruise ? 'Cruise control on · the FTL throttle holds · W / S adjust it' : 'Cruise control off · hold W to keep the FTL drive running', 'ftl');
}

/**
 * Manual FTL flight: W / S move the throttle, and the drive slows itself near massive bodies.
 * With cruise control off the throttle spools down whenever W is released, and the drive drops
 * out by itself once it idles; with cruise control on it holds wherever you leave it.
 */
export function ftlCruise(g: Game, dt: number) {
  const { ship, keys } = g;
  if (keys.KeyW) ship.throttle = Math.min(1, ship.throttle + 0.45 * dt);
  else if (!ship.cruise) ship.throttle = Math.max(0, ship.throttle - SPOOL_DOWN * dt);
  if (ship.throttle > 0.05) ship.ftlSpooled = true;
  if (keys.KeyS) ship.throttle = Math.max(0, ship.throttle - 0.45 * dt);
  if (keys.KeyX) ship.throttle = 0;
  const vmax = ftlSpeedLimit(g);
  ship.vmax = vmax;
  const tgt = ship.throttle * vmax;
  if (ship.ftlSpeed < tgt) ship.ftlSpeed = Math.min(tgt, ship.ftlSpeed * Math.exp(1.5 * dt) + 20000 * dt);
  else ship.ftlSpeed = Math.max(tgt, ship.ftlSpeed * Math.exp(-2.5 * dt));
  ship.ftlSpeed = Math.min(ship.ftlSpeed, vmax);
  ship.pos.addScaledVector(ship.travelDir, ship.ftlSpeed * dt);
  g.curSpeed = ship.ftlSpeed;
  if (ftlUpkeep(g, dt, ship.throttle)) {
    // arriving from a hyperjump leaves the drive idle but not spooled, so you stay in FTL until you use it
    if (!ship.cruise && ship.ftlSpooled && ship.throttle === 0 && ship.ftlSpeed < SPOOL_DROP_SPEED) {
      dropFTL(g, false);
      if (!g.refFrame) g.showMsg('FTL drive spooled down · press F for cruise control'); // keep "matched <station>" if we dropped beside one
      return;
    }
    for (const b of g.cur.bodies) {
      const alt = b.pos.distanceTo(ship.pos) - b.radius;
      if (alt < dropAlt(b)) {
        dropFTL(g, true, b);
        break;
      }
    }
  }
}
