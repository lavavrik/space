/*
 * Hitting a trojan swarm's rocks (docs/lagrange.md): the ring's collision rules (sim/ringContact.ts)
 * against a swarm's rocks (sim/swarm.ts). After the ship moves, its path over the step is swept
 * against the rocks round it; a rock lighter than the ship is knocked aside (spent for SPENT_S), a
 * heavier one bounces the ship; damage goes by the closing speed scaled for the rock's mass.
 */
import { CRASH_SPEED } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { impact } from './damage';
import { frameVel } from './frame';
import { shipMass } from './resources';
import { BOUNCE, ROCK_K, ROCK_SCRAPE, effectiveSpeed, minedRocks, rockLabel, rockMass } from './ringRocks';
import { shipRadiusAlong } from './ringContact';
import { swarmHere, swarmRocks, type SwarmRock } from './swarm';

const SPENT_S = 120;
const spent = new WeakMap<Game, Map<string, number>>();
const lastNote = new WeakMap<Game, number>();

const a = new THREE.Vector3(),
  b = new THREE.Vector3(),
  aSys = new THREE.Vector3(),
  vRel = new THREE.Vector3(),
  dir = new THREE.Vector3(),
  s0 = new THREE.Vector3(),
  d = new THREE.Vector3(),
  rp = new THREE.Vector3(),
  normal = new THREE.Vector3();

/** After the ship's move this step (dt s): any swarm rock in the way? */
export function swarmContact(g: Game, dt: number) {
  const { ship } = g;
  if (ship.mode !== 'normal' || ship.dead || ship.landed || g.warp > 1 || dt <= 0) return;
  const w = g.frameBody;
  const here = swarmHere(g.cur, ship, w);
  if (!here) return;
  b.subVectors(ship.pos, w.pos);
  a.copy(b).addScaledVector(ship.vel, -dt);
  dir.copy(ship.vel).sub(frameVel(g));
  const shipR = shipRadiusAlong(g, dir.lengthSq() > 1e-6 ? dir.normalize() : dir.set(0, 0, -1).applyQuaternion(ship.q));
  const sp = spent.get(g) ?? spent.set(g, new Map()).get(g)!;
  const list: SwarmRock[] = [];
  aSys.addVectors(a, w.pos);
  swarmRocks(here.field, here.centre, aSys, ship.pos, shipR + 100 + 500, w.pos, w.vel, list, (k) => (sp.get(k) ?? -Infinity) > g.simTime, (k) => minedRocks.get(k));
  // the nearest touch over the step: the ship against each rock (which also moves)
  let best: SwarmRock | null = null,
    bestT = Infinity;
  for (const rock of list) {
    const R = rock.size * ROCK_K + shipR;
    s0.copy(a).sub(rp.copy(rock.pos).addScaledVector(rock.vel, -dt));
    d.copy(b).sub(rock.pos).sub(s0);
    const A = d.lengthSq(),
      B = 2 * s0.dot(d),
      C = s0.lengthSq() - R * R;
    let th: number;
    if (C <= 0) {
      if (B >= 0) continue;
      th = 0;
    } else {
      const disc = B * B - 4 * A * C;
      if (A < 1e-12 || disc < 0) continue;
      th = (-B - Math.sqrt(disc)) / (2 * A);
      if (th < 0 || th > 1) continue;
    }
    if (th >= bestT) continue;
    best = rock;
    bestT = th;
    normal.copy(s0).addScaledVector(d, th).normalize();
  }
  if (!best) return;
  const rock = best;
  vRel.copy(ship.vel).sub(rock.vel);
  const vn = -vRel.dot(normal);
  if (vn <= 0) return;
  const R = rock.size * ROCK_K + shipR;
  const ms = shipMass(ship),
    mr = rockMass(rock.size);
  const size = rockLabel(rock.size);
  const h0 = ship.hull;
  if (impact(g, effectiveSpeed(vn, mr, ms), ROCK_SCRAPE, CRASH_SPEED, `a ${size} rock`, w, vn)) return;
  ship.vel.addScaledVector(normal, (1 + BOUNCE) * vn * (mr / (mr + ms)));
  if (mr < ms) {
    sp.set(rock.key, g.simTime + SPENT_S);
    for (const [k, until] of sp) if (until < g.simTime) sp.delete(k);
  } else ship.pos.copy(w.pos).add(rock.pos).addScaledVector(normal, R + 0.05);
  if (ship.ap) ship.ap.settled = false;
  const now = performance.now() / 1000,
    last = lastNote.get(g) ?? -Infinity;
  if (vn > 0.5 && ship.hull >= h0 - 0.01 && now - last > 3) {
    lastNote.set(g, now);
    g.showMsg(`${mr < ms ? 'Knocked aside' : 'Bumped'} a ${size} rock at ${vn.toFixed(1)} m/s`, 'warn');
  }
}
