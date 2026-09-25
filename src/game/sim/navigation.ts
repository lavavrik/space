import { AU, JUMP_CHARGE_TIME, JUMP_RANGE, LY, SHIP, jumpCost } from '../constants';
import type { Game } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import { findHome } from '../universe/system';
import type { Ship, StarSystem } from '../types';
import { massLock } from './ftl';
import { startJumpGuide } from './guide';
import { closePlanner } from './planner';

export function lookAt(ship: Ship, to: THREE.Vector3) {
  const m = new THREE.Matrix4().lookAt(ship.pos, to, new THREE.Vector3(0, 1, 0));
  ship.q.setFromRotationMatrix(m);
}

/** Ship position in the galaxy, in light-years. */
export function galPos(g: Game) {
  return g.cur.sys.pos.clone().addScaledVector(g.ship.pos, 1 / LY);
}

/* ---------- targeting ---------- */

/** Target the body closest to the centre of view. */
export function targetAhead(g: Game) {
  const { ship } = g;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
  let best = null,
    bestA = 0.35;
  for (const b of g.cur.bodies) {
    const d = b.pos.clone().sub(ship.pos);
    const dist = d.length();
    const ang = Math.acos(Math.min(1, d.dot(fwd) / dist));
    const angR = Math.atan(b.radius / dist);
    const a = Math.max(0, ang - angR);
    if (a < bestA) {
      bestA = a;
      best = b;
    }
  }
  if (best) {
    g.target = best;
    g.showMsg(`Target · ${best.name}`);
  } else g.showMsg('Nothing ahead · aim closer or press G');
}

/** Cycle targets by distance. */
export function cycleTarget(g: Game) {
  const { ship } = g;
  const sorted = g.cur.bodies.slice().sort((a, b) => a.pos.distanceTo(ship.pos) - b.pos.distanceTo(ship.pos));
  const i = g.target ? sorted.indexOf(g.target) : -1;
  g.target = sorted[(i + 1) % sorted.length];
  g.showMsg(`Target · ${g.target.name}`);
}

/* ---------- hyperjumps ---------- */

export function reachable(g: Game) {
  const gp = galPos(g);
  return g.systems
    .filter((s) => s !== g.cur.sys && s.pos.distanceTo(gp) <= JUMP_RANGE)
    .sort((a, b) => a.pos.distanceTo(gp) - b.pos.distanceTo(gp));
}

export function cycleDest(g: Game) {
  const list = reachable(g);
  if (!list.length) {
    g.showMsg('No star systems within jump range', 'warn');
    return;
  }
  const i = g.jumpDest ? list.indexOf(g.jumpDest) : -1;
  g.jumpDest = list[(i + 1) % list.length];
  g.showMsg(`Jump destination · ${g.jumpDest.name} · ${g.jumpDest.pos.distanceTo(galPos(g)).toFixed(2)} ly`, 'ftl');
}

export function startJump(g: Game) {
  const { ship } = g;
  if (g.jump) return;
  const dest = g.jumpDest;
  if (!dest) {
    g.showMsg('Press N to pick a star system first', 'warn');
    return;
  }
  const d = dest.pos.distanceTo(galPos(g));
  if (d > JUMP_RANGE) {
    g.showMsg('Destination out of range', 'warn');
    return;
  }
  const lock = massLock(g);
  if (lock) {
    g.showMsg(`Mass-locked by ${lock.name}`, 'warn');
    return;
  }
  const cost = jumpCost(d);
  if (ship.exotic < cost) {
    g.showMsg(`Jump needs ${cost.toFixed(1)} kg of exotic matter · you have ${ship.exotic.toFixed(1)} kg`, 'warn');
    return;
  }
  const needKWh = (SHIP.jumpChargeKW * JUMP_CHARGE_TIME) / 3600 + 1;
  if (ship.batt < needKWh) {
    g.showMsg(`Hyperdrive needs ${needKWh.toFixed(0)} kWh of battery to charge`, 'warn');
    return;
  }
  ship.ftlCharge = 0;
  ship.ap = null;
  closePlanner(g);
  ship.tanker = null;
  g.jump = { phase: 'charge', t: JUMP_CHARGE_TIME, dest, loaded: false, cost };
  startJumpGuide(g, g.jump, d);
  g.showMsg(`Hyperdrive charging · ${dest.name}`, 'ftl');
}

/** Load the destination system and drop the ship in, in FTL, facing the star. */
export function arriveAt(g: Game, sys: StarSystem) {
  const { ship } = g;
  g.loadSystem(sys);
  const r = mulberry32(sys.seed + 5);
  const dir = new THREE.Vector3(rr(r, -1, 1), rr(r, 0.15, 0.5), rr(r, -1, 1)).normalize();
  ship.pos.copy(g.cur.star.pos).addScaledVector(dir, Math.max(g.cur.star.radius * 70, 0.05 * AU));
  lookAt(ship, g.cur.star.pos);
  ship.vel.set(0, 0, 0);
  ship.mode = 'ftl';
  ship.throttle = 0;
  ship.ftlSpeed = 0;
}

/** Start above the Earth-like home world, looking past it with the star to the side. */
export function placeAtHome(g: Game) {
  const { ship } = g;
  g.loadSystem(g.systems[0]);
  const home = findHome(g.cur.bodies)!;
  const toStar = g.cur.star.pos.clone().sub(home.pos).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(toStar, up).normalize();
  const dir = toStar.clone().multiplyScalar(0.45).addScaledVector(side, 0.85).addScaledVector(up, 0.18).normalize();
  ship.pos.copy(home.pos).addScaledVector(dir, home.radius * 3.1);
  const aim = home.pos.clone().addScaledVector(side, home.radius * 0.9).addScaledVector(toStar, home.radius * 0.5);
  lookAt(ship, aim);
  g.target = home;
}
