import { FTL_CHARGE_TIME, FTL_MAX, NORMAL_MAX, REARTH, SHIP, ftlBurn } from '../constants';
import { grant } from './power';
import { heatBlocked } from './thermal';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Ship } from '../types';
import { FRAME_ENTER, stationVel, stationWithin } from './frame';
import { apLabel } from './orbits';
import { RING_HALF_THICK } from './rings';

/** How strongly a body's gravity well slows the FTL drive. */
export function wellFactor(b: Body) {
  return Math.min(12, Math.max(0.6, Math.sqrt(b.radius / REARTH)));
}

/** Altitude below which the FTL drive drops out. */
export function dropAlt(b: Body) {
  return b.kind === 'star' ? b.radius * 0.6 : Math.max(b.radius * 0.12, 30e3);
}

/** The mass lock reaches this many times a world's FTL drop-out altitude. */
export const MASS_LOCK_K = 1.15;

/** The body whose gravity well stops the FTL drive from starting, if any. */
export function massLock(g: Game) {
  for (const b of g.cur.bodies) {
    const alt = b.pos.distanceTo(g.ship.pos) - b.radius;
    if (alt < dropAlt(b) * MASS_LOCK_K) return b;
  }
  return null;
}

/** Within this of a ring belt's slab (m, off its plane or past its edges), the FTL drive won't start. */
export const BELT_FTL_CLEAR = 10e3;

/**
 * The world whose ring belt is too close for the FTL drive to start (among its rocks, or within
 * BELT_FTL_CLEAR of their slab), if any. A ring's rocks are well outside its world's mass lock, so
 * without this you could jump to FTL from among them.
 */
export function beltLock(g: Game) {
  for (const b of g.cur.bodies) {
    if (b.kind === 'star' || !b.ring) continue;
    const rel = g.ship.pos.clone().sub(b.pos);
    const h = rel.dot(b.axis);
    const r = Math.sqrt(Math.max(0, rel.lengthSq() - h * h));
    if (Math.abs(h) < RING_HALF_THICK + BELT_FTL_CLEAR && r > b.ring.inner * b.radius - BELT_FTL_CLEAR && r < b.ring.outer * b.radius + BELT_FTL_CLEAR) return b;
  }
  return null;
}

/**
 * The way out of a mass lock: the direction that climbs fastest out of every well holding you
 * (straight away from the one world, or a blend weighted by how deep you are in each), and the
 * height still to climb (m) out of the deepest. Null when nothing holds you.
 */
export function massLockExit(g: Game) {
  const dir = new THREE.Vector3();
  let climb = 0,
    body: Body | null = null;
  for (const b of g.cur.bodies) {
    const away = new THREE.Vector3().subVectors(g.ship.pos, b.pos);
    const d = away.length();
    const left = dropAlt(b) * MASS_LOCK_K - (d - b.radius);
    if (left <= 0) continue;
    dir.addScaledVector(away.divideScalar(d), left);
    if (left > climb) {
      climb = left;
      body = b;
    }
  }
  if (!body || dir.lengthSq() < 1e-12) return null;
  return { dir: dir.normalize(), climb, body };
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
  if (!ship.breakers.ftl) return 'The FTL drive is switched off · ship stats (U), power';
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
  if (!ship.breakers.ftl) why = 'Switched off';
  else if (ship.exotic <= 0) why = 'Exotic matter exhausted';
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
  if (g.inStation || g.dock?.docked) {
    g.showMsg('Not inside a station · leave through the slot first', 'warn');
    return;
  }
  const lock = massLock(g);
  if (lock) {
    g.showMsg(`Mass-locked by ${lock.name} · climb above ${fmtDist(dropAlt(lock) * MASS_LOCK_K)}`, 'warn');
    return;
  }
  const belt = beltLock(g);
  if (belt) {
    g.showMsg(`Too close to ${belt.name}'s ring belt for FTL · get ${fmtDist(BELT_FTL_CLEAR)} clear of its rocks`, 'warn');
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
  ship.ftlLeaving = g.cur.stations.filter((st) => st.pos.distanceTo(ship.pos) < STATION_DROP).map((st) => st.name);
  ship.tanker = null;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
  ship.travelDir.copy(fwd); // the drive always spins up along the nose
  // at the speed you were doing, the throttle where it holds it (it used to add 30 km/s and set
  // the throttle to 30 %: a shove forward the moment the drive engaged)
  ship.ftlSpeed = ship.vel.length() + (ship.ftlCoast ?? 0);
  ship.ftlCoast = 0;
  ship.throttle = Math.min(1, ship.ftlSpeed / ftlSpeedLimit(g));
  ship.vel.set(0, 0, 0);
  ship.landed = null;
  if (g.ship === ship && g.warpFx) g.warpFx.push({ r: 0.9, age: 0, dur: 1.1 }); // (the field forming round you)
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
  // keep moving the way the drive was pushing, which may not be where the nose points; past the
  // normal-space limit the drive's collapsing field carries you on, fading (coastFTL): the speed
  // used to fall to 4 km/s the moment you dropped out. (Forced out by a body: no coast, it's close.)
  ship.vel.copy(ship.travelDir).multiplyScalar(forced ? 500 : Math.min(ship.ftlSpeed, NORMAL_MAX));
  ship.ftlCoast = forced ? 0 : Math.max(0, ship.ftlSpeed - NORMAL_MAX);
  ship.ftlCoastK = 0;
  if (g.warpFx) g.warpFx.push({ r: 0.9, age: 0, dur: 1.1 }); // (the field collapsing)
  ship.ftlSpeed = 0;
  if (ship.ap) {
    ship.ap.phase = 'insert';
    // (at rest relative to the target; a Lagrange point's is its planet, whose velocity in the star's frame is its orbit's)
    if (ship.ap.type === 'lagrange') ship.vel.copy(ship.ap.body.vel).sub(g.frameBody.vel);
    else ship.vel.set(0, 0, 0);
    ship.ftlCoast = 0;
    g.showMsg(`Autopilot · inserting into ${apLabel(ship.ap)}`, 'ftl');
    return;
  }
  if (forced && body) g.showMsg(`Emergency drop · too close to ${body.name}`, 'warn');
  else {
    // dropping out beside a station puts you straight into its frame, moving with it
    const st = stationWithin(g, FRAME_ENTER);
    if (st) {
      ship.vel.add(stationVel(g, st));
      ship.ftlCoast = 0;
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
  const kw = ship.breakers.charge ? grant(g, SHIP.ftlChargeKW, 'FTL charging') : 0; // switched off: the charge pauses
  g.power.chargeKW = kw;
  ship.ftlCharge -= (dt * kw) / SHIP.ftlChargeKW;
  if (ship.ftlCharge <= 0) {
    ship.ftlCharge = 0;
    // charged: hand this frame's charging power back so the drive can run on it straight away
    // (without this the drive started with nothing left this frame and failed at once)
    g.power.left += kw;
    g.power.chargeKW = 0;
    g.power.ftlShort = 0;
    if (!massLock(g) && !beltLock(g)) engageFTL(g);
    else if (ship.ap) ship.ap.phase = 'insert';
    else g.showMsg(beltLock(g) ? 'FTL aborted · too close to a ring belt' : 'FTL aborted · mass-locked', 'warn');
  }
}

/** Flying at a station in FTL, the drive drops out this far from it (m). */
export const STATION_DROP = 100e3;

/**
 * A station the ship, flying `step` metres along its course this frame, comes within STATION_DROP
 * of while closing on it, and how far along the step (s, m) that happens. Leaving one (starting FTL
 * right beside it) doesn't count.
 */
function stationAhead(g: Game, step: number) {
  const { ship } = g;
  const dir = ship.travelDir;
  for (const st of g.cur.stations) {
    const rel = tmpS.subVectors(st.pos, ship.pos);
    // one you started out from (in its bubble when the drive engaged) doesn't stop you until you've
    // left its bubble: the course out often runs past it, and it dropped you straight back out
    // (under the autopilot: charge, drop, charge again, over and over)
    if (ship.ftlLeaving?.includes(st.name)) {
      if (rel.length() > STATION_DROP * 1.02) ship.ftlLeaving = ship.ftlLeaving.filter((n) => n !== st.name);
      continue;
    }
    const along = rel.dot(dir);
    if (along <= 0) continue; // behind: moving away
    const d2 = rel.lengthSq(),
      R2 = STATION_DROP * STATION_DROP;
    const perp2 = d2 - along * along;
    if (perp2 >= R2) continue; // the course passes wide of it
    // where the course enters the bubble (or here, if already inside it and still closing)
    const s = Math.max(0, along - Math.sqrt(R2 - perp2));
    if (s <= step) return { st, s };
  }
  return null;
}
const tmpS = new THREE.Vector3();

/** Throttle lost per second with cruise control off and W released: from full to idle in ~6 s. */
const SPOOL_DOWN = 0.17;

/** Cruise control (F): hold the FTL throttle where it is instead of letting it spool down. */
export function toggleCruise(g: Game) {
  const { ship } = g;
  ship.cruise = !ship.cruise;
  g.showMsg(ship.cruise ? 'Cruise control on · the FTL throttle holds · W / S adjust it' : 'Cruise control off · hold W to keep the FTL drive running', 'ftl');
}

/**
 * Manual FTL flight: W / S move the throttle, and the drive slows itself near massive bodies.
 * With cruise control off the throttle spools down whenever W is released and the drive idles (it
 * still draws its upkeep); with cruise control on it holds wherever you leave it. It only drops out
 * when you press J, or on its own too close to a body.
 */
export function ftlCruise(g: Game, dt: number) {
  const { ship, keys } = g;
  if (keys.KeyW) ship.throttle = Math.min(1, ship.throttle + 0.45 * dt);
  else if (!ship.cruise) ship.throttle = Math.max(0, ship.throttle - SPOOL_DOWN * dt);
  if (keys.KeyS) ship.throttle = Math.max(0, ship.throttle - 0.45 * dt);
  if (keys.KeyX) ship.throttle = 0;
  const vmax = ftlSpeedLimit(g);
  ship.vmax = vmax;
  const tgt = ship.throttle * vmax;
  if (ship.ftlSpeed < tgt) ship.ftlSpeed = Math.min(tgt, ship.ftlSpeed * Math.exp(1.5 * dt) + 20000 * dt);
  else ship.ftlSpeed = Math.max(tgt, ship.ftlSpeed * Math.exp(-2.5 * dt));
  ship.ftlSpeed = Math.min(ship.ftlSpeed, vmax);
  const step = ship.ftlSpeed * dt;
  // closing on a station: drop out STATION_DROP from it, matched to its orbit (at FTL speed that
  // bubble can be crossed in a frame, so check along this frame's whole path)
  const st = stationAhead(g, step);
  if (st) {
    ship.pos.addScaledVector(ship.travelDir, st.s);
    dropFTL(g, false);
    ship.vel.copy(stationVel(g, st.st));
    ship.ftlCoast = 0;
    g.refFrame = st.st;
    g.showMsg(`Dropped out approaching ${st.st.name} · matched its orbit`);
    return;
  }
  ship.pos.addScaledVector(ship.travelDir, step);
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

/** The FTL field's coast after dropping out fades at this rate (1/s) in open space: ~2 s to nothing. */
const COAST_FADE = 2.3;

/**
 * Just out of FTL, in normal space: carry the ship on along its last FTL course at `ftlCoast`,
 * fading. Near a body or a station it fades faster, so the coast never covers more than a fifth of
 * the way to it (you don't sail into a world you dropped out beside). Returns the coast speed left.
 */
export function coastFTL(g: Game, dt: number) {
  const { ship } = g;
  const v = ship.ftlCoast ?? 0;
  if (v <= 0) return 0;
  // its rate, set as it starts (the distance a coast at rate k covers is v / k; set afresh each
  // frame against the shrinking gap, it crept on toward the world)
  if (!ship.ftlCoastK) {
    let clear = Infinity;
    for (const b of g.cur.bodies) clear = Math.min(clear, b.pos.distanceTo(ship.pos) - b.radius);
    for (const st of g.cur.stations) clear = Math.min(clear, st.pos.distanceTo(ship.pos));
    ship.ftlCoastK = Math.max(COAST_FADE, v / Math.max(0.2 * clear, 1));
  }
  const k = ship.ftlCoastK;
  const f = Math.exp(-k * dt);
  ship.pos.addScaledVector(ship.travelDir, (v * (1 - f)) / k);
  ship.ftlCoast = v * f < 1 ? 0 : v * f;
  if (!ship.ftlCoast) ship.ftlCoastK = 0;
  return ship.ftlCoast;
}
