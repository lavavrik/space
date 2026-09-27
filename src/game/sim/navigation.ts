import { ARRIVE_STAR_RADII, JUMP_CHARGE_TIME, JUMP_RANGE, LY, SHIP, jumpCost } from '../constants';
import type { Game } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import { homeSystem } from '../universe/galaxy';
import { findHome } from '../universe/system';
import type { Ship, StarSystem, Target } from '../types';
import { resetFrame } from './frame';
import { pickNavStar, replan } from './navroute';
import { massLock } from './ftl';
import { dominantBody } from './gravity';
import { startJumpGuide } from './guide';
import { transitTime } from './hyperspace';
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
  let best: Target | null = null,
    bestA = 0.35;
  for (const b of [...g.cur.bodies, ...g.cur.stations]) {
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

/** Click tolerance in px: how far from a small object's marker a click still hits it. */
const CLICK_PX = 14;

/**
 * Target what's at screen pixel (sx, sy). Small things drawn as markers (stations, distant bodies)
 * win when the click lands on their marker, even in front of a big planet's disc; otherwise the
 * nearest disc under the click. Failing both, a reachable star becomes the jump destination.
 * Returns false if there's nothing there.
 */
export function pickAt(g: Game, sx: number, sy: number) {
  const { ship } = g;
  const { W, H, pxPerRad } = g.view;
  const v = new THREE.Vector3();
  const project = (rel: THREE.Vector3) => {
    v.copy(rel).applyQuaternion(g.qInv);
    return v.z < 0 ? { x: W / 2 + (v.x / -v.z) * pxPerRad, y: H / 2 - (v.y / -v.z) * pxPerRad } : null;
  };
  let marker: Target | null = null,
    markerMiss = CLICK_PX,
    disc: Target | null = null,
    discDist = Infinity;
  for (const t of [...g.cur.bodies, ...g.cur.stations]) {
    const rel = t.pos.clone().sub(ship.pos);
    const dist = rel.length();
    const p = project(rel);
    if (!p) continue;
    const pxR = (t.radius / dist) * pxPerRad;
    const off = Math.hypot(p.x - sx, p.y - sy);
    if (pxR < CLICK_PX) {
      if (off < markerMiss) {
        marker = t;
        markerMiss = off;
      }
    } else if (off <= pxR && dist < discDist) {
      disc = t;
      discDist = dist;
    }
  }
  const best = marker ?? disc;
  if (best) {
    g.target = best;
    g.showMsg(`Target · ${best.name}`);
    return true;
  }
  const gp = galPos(g);
  if (g.navPanel && !g.route?.running) {
    // nav panel open: any star in the sky (within SKY_RADIUS) can be the route's destination
    const s = pickNavStar(g, (s) => {
      const p = project(s.pos.clone().sub(gp).normalize().multiplyScalar(1e6));
      return p ? Math.hypot(p.x - sx, p.y - sy) : Infinity;
    });
    if (s) {
      g.navDest = s;
      replan(g);
      g.showMsg(`Route destination · ${s.name} · ${s.pos.distanceTo(gp).toFixed(1)} ly`, 'ftl');
      return true;
    }
  }
  let star: StarSystem | null = null,
    starMiss = CLICK_PX;
  for (const s of reachable(g)) {
    const p = project(s.pos.clone().sub(gp).normalize().multiplyScalar(1e6));
    if (!p) continue;
    const miss = Math.hypot(p.x - sx, p.y - sy);
    if (miss < starMiss) {
      starMiss = miss;
      star = s;
    }
  }
  if (star) {
    g.jumpDest = star;
    g.showMsg(`Jump destination · ${star.name} · ${star.pos.distanceTo(gp).toFixed(2)} ly`, 'ftl');
    return true;
  }
  return false;
}

/** Cycle targets by distance. */
export function cycleTarget(g: Game) {
  const { ship } = g;
  const sorted = [...g.cur.bodies, ...g.cur.stations].sort((a, b) => a.pos.distanceTo(ship.pos) - b.pos.distanceTo(ship.pos));
  const i = g.target ? sorted.indexOf(g.target) : -1;
  g.target = sorted[(i + 1) % sorted.length];
  g.showMsg(`Target · ${g.target.name}`);
}

/* ---------- hyperjumps ---------- */

/** Systems within jump range of the ship, nearest first. */
export function reachable(g: Game) {
  const gp = galPos(g);
  return g.nearby.filter((s) => s.pos.distanceTo(gp) <= JUMP_RANGE).sort((a, b) => a.pos.distanceTo(gp) - b.pos.distanceTo(gp));
}

/** How far from the crosshair (rad) a star can be and still be picked by aiming at it. */
const AIM_CONE = 0.06;

/**
 * Pick a jump destination: the reachable star nearest the crosshair if you're aiming at one,
 * otherwise the next one out by distance.
 */
export function pickDest(g: Game) {
  const list = reachable(g);
  if (!list.length) {
    g.showMsg('No star systems within jump range', 'warn');
    return;
  }
  const gp = galPos(g);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.ship.q);
  const dir = new THREE.Vector3();
  let aimed: StarSystem | null = null,
    bestA = AIM_CONE;
  for (const s of list) {
    const a = dir.subVectors(s.pos, gp).normalize().angleTo(fwd);
    if (a < bestA) {
      bestA = a;
      aimed = s;
    }
  }
  if (aimed && aimed.id !== g.jumpDest?.id) g.jumpDest = aimed;
  else {
    const i = g.jumpDest ? list.findIndex((s) => s.id === g.jumpDest!.id) : -1;
    g.jumpDest = list[(i + 1) % list.length];
  }
  g.showMsg(`Jump destination · ${g.jumpDest.name} · ${g.jumpDest.pos.distanceTo(gp).toFixed(2)} ly`, 'ftl');
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
  g.jump = { phase: 'charge', t: JUMP_CHARGE_TIME, dest, cost, from: galPos(g), dur: transitTime(d) };
  startJumpGuide(g, g.jump, d);
  g.showMsg(`Hyperdrive charging · ${dest.name}`, 'ftl');
}

/** Load the destination system and drop the ship in, in FTL, facing the star. */
export function arriveAt(g: Game, sys: StarSystem) {
  const { ship } = g;
  g.loadSystem(sys);
  const r = mulberry32(sys.seed + 5);
  const dir = new THREE.Vector3(rr(r, -1, 1), rr(r, 0.15, 0.5), rr(r, -1, 1)).normalize();
  // drop in close: ARRIVE_STAR_RADII from the centre the star spans ~11° of sky, outside the corona
  // (scooping starts at 2.5 radii) and well clear of the FTL drop-out altitude (1.6 radii)
  ship.pos.copy(g.cur.star.pos).addScaledVector(dir, g.cur.star.radius * ARRIVE_STAR_RADII);
  lookAt(ship, g.cur.star.pos);
  ship.vel.set(0, 0, 0);
  resetFrame(g, dominantBody(g.cur, ship.pos));
  ship.mode = 'ftl';
  ship.throttle = 0;
  ship.ftlSpooled = false;
  ship.ftlSpeed = 0;
}

/** Start above the Earth-like home world, looking past it with the star to the side. */
export function placeAtHome(g: Game) {
  const { ship } = g;
  g.loadSystem(homeSystem());
  const home = findHome(g.cur.bodies)!;
  const toStar = g.cur.star.pos.clone().sub(home.pos).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(toStar, up).normalize();
  const dir = toStar.clone().multiplyScalar(0.45).addScaledVector(side, 0.85).addScaledVector(up, 0.18).normalize();
  ship.pos.copy(home.pos).addScaledVector(dir, home.radius * 3.1);
  const aim = home.pos.clone().addScaledVector(side, home.radius * 0.9).addScaledVector(toStar, home.radius * 0.5);
  lookAt(ship, aim);
  ship.vel.set(0, 0, 0);
  resetFrame(g, dominantBody(g.cur, ship.pos)); // start at rest relative to the home world
  g.target = home;
}
