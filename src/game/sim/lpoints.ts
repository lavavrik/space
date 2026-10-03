/*
 * Lagrange points as targets (docs/lagrange.md): T and G reach them, a click on their marker or on
 * the system map picks them, the info panel (I) describes them, the orbit planner (O) opens already
 * set to hold at the one targeted. The points are on rails (sim/lagrange.ts), not bodies, so each is
 * a small object that keeps its identity (g.target stays equal to itself) while its position and
 * velocity are refreshed from the planet whenever they're asked for.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { LTarget, World } from '../types';
import { lagrangePoints } from './lagrange';
import { known } from './radar';

const cache = new WeakMap<World, LTarget[]>();
const refreshed = new WeakMap<World, number>();

/** The five points of `w` as targets, their state as of sim time `t`. */
export function lpointTargets(w: World, t: number): LTarget[] {
  let list = cache.get(w);
  const fresh = refreshed.get(w) === t;
  if (list && fresh) return list;
  const pts = lagrangePoints(w);
  if (!list) {
    list = pts.map((p) => ({
      kind: 'lpoint' as const,
      name: p.name,
      typeName: `Lagrange point · ${w.name}`,
      planet: w,
      k: p.k,
      radius: 2e4,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      at: t,
    }));
    cache.set(w, list);
  }
  pts.forEach((p, i) => {
    list![i].pos.copy(p.pos);
    list![i].vel.copy(p.vel);
    list![i].at = t;
  });
  refreshed.set(w, t);
  return list;
}

/** Every Lagrange point of the planets the ship's instruments know, as targets (nearest first is the caller's business). */
export function lpointsHere(g: Game): LTarget[] {
  const out: LTarget[] = [];
  for (const b of g.cur.bodies) if (b.kind === 'planet' && known(g, b)) out.push(...lpointTargets(b, g.simTime));
  return out;
}

/** The target for planet `w`'s point `k`, as of now. */
export const lpointFor = (g: Game, w: World, k: number) => lpointTargets(w, g.simTime)[k - 1];
