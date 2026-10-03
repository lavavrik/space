/*
 * Lagrange points as targets (docs/lagrange.md): a planet's five show, and T, G and a click on
 * their markers reach them, only while that planet or one of its points is the target
 * (`lpointsShown`); the system map, the nav search and the radar's swarm contacts reach any of them.
 * A click on the system map picks them, the info panel (I) describes them, the orbit planner (O) opens already
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

/**
 * The points the HUD shows and T, G and clicks can pick: the five of the targeted planet, or of the
 * targeted point's planet (so you can hop between them). None otherwise: every known planet's five
 * at once cluttered the view.
 */
export function lpointsShown(g: Game): LTarget[] {
  const t = g.target;
  const w = t?.kind === 'planet' ? t : t?.kind === 'lpoint' ? t.planet : null;
  return w && known(g, w) ? lpointTargets(w, g.simTime) : [];
}

/**
 * Bring a targeted point up to this step (call after the bodies have moved, as stations are): its
 * position is otherwise refreshed only when something asks for the points, and the pivot (Shift+T)
 * and the HUD read the target's own fields. Without it the pivot aimed a frame behind, and under
 * time warp (or with nothing drawing it) wherever the point was when last asked.
 */
export function refreshTarget(g: Game) {
  const t = g.target;
  if (t?.kind === 'lpoint') lpointTargets(t.planet, g.simTime);
}

/** The target for planet `w`'s point `k`, as of now. */
export const lpointFor = (g: Game, w: World, k: number) => lpointTargets(w, g.simTime)[k - 1];
