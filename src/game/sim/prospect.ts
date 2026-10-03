/**
 * Prospecting (docs/rings.md, "Mining"): a radar sweep in a ring's belt also picks out its
 * metal-rich rocks (one in 33: sim/laser.ts rockMake), from the same generator the renderer draws
 * with (sim/ringRocks.ts), and ranks them by what the scoop could get out of them. The best
 * PROSPECT_MAX are kept, and followed round their orbits (rockOn) so the HUD can mark them.
 *
 * It looks through the rocks (20–140 m across) within PROSPECT_NEAR, and the boulders (140 m–1 km)
 * within PROSPECT_FAR. Pebbles aren't worth it. Metal-rich rocks are common enough (dozens within
 * a few km) that a ranked shortlist is what's useful. They're ranked by what an hour under your
 * laser at close range would fetch (the beam breaks rock up at a fixed rate, so a richer rock pays
 * faster), capped by the metal a small rock actually holds: a platinum-rich rock of any real size
 * comes first. (Ranking by the rock's whole metal put 1 km nickel-iron boulders, holding thousands
 * of tonnes, over everything: more than 50 holds' worth, which no one mines out.)
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { TrojanField, World } from '../types';
import { COMMODITIES, type Commodity } from './economy';
import { DISPERSE, METAL_CATCH, YIELD_PER_MW, rockMake, type RockMake } from './laser';
import { laserFitted } from '../outfit/catalog';
import { METAL_RICH, minedKey, minedRocks, rockMass, rockOn, rocksNear, type Rock } from './ringRocks';
import { TROJAN_METAL_RICH } from './laser';
import { swarmCentre, swarmHere, swarmKey, swarmRocks, type SwarmRock } from './swarm';

export const PROSPECT_NEAR = 5e3;
export const PROSPECT_FAR = 40e3;
export const PROSPECT_MAX = 6;

export interface Prospect {
  id: string;
  /** The ring's world (the finds are only good in its belt). */
  world: string;
  size: number;
  kind: RockMake['kind'];
  /** Metal the scoop would catch mining it all (kg); Cr/kg of that metal (list); and Cr an hour under your laser. */
  metalKg: number;
  perKg: number;
  perHour: number;
  /** Planet-centred, at t0 (sim time). */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  t0: number;
  /** A trojan swarm's rock (`world` is then the swarm's id): its offset from the swarm's centre, in system axes, which holds. */
  swarm?: { off: THREE.Vector3 };
}

/**
 * What a rock is worth to mine: the metal the scoop would catch mining it right down (kg), that
 * metal's list price (Cr/kg), and Cr an hour under a `kw` beam at close range (no more than it holds).
 */
export function rockWorth(size: number, make: RockMake, kw: number) {
  const metalKg = rockMass(size) * make.metal * METAL_CATCH;
  let perKg = 0;
  for (const c of Object.keys(make.mix) as Commodity[]) perKg += make.mix[c] * COMMODITIES[c].price;
  const kgPerS = YIELD_PER_MW * (kw / 1000) * DISPERSE * make.metal * METAL_CATCH;
  return { metalKg, perKg, perHour: Math.min(kgPerS * 3600, metalKg) * perKg };
}

/** The best metal-rich rocks around the ship (at a sweep's end), best first. Empty outside a belt. */
export function prospect(g: Game): Prospect[] {
  const w = g.frameBody;
  const here = w.kind === 'star' || !w.ring ? swarmHere(g.cur, g.ship, w) : null;
  if (here) return prospectSwarm(g, here.field, here.centre);
  if (w.kind === 'star' || !w.ring) return [];
  const at = g.ship.pos.clone().sub(w.pos);
  const kw = laserFitted(g.ship.outfit)?.caps.kw ?? 600; // (no laser: as an ML-6 would)
  const found: Prospect[] = [];
  for (const [layer, reach] of [
    [1, PROSPECT_NEAR],
    [2, PROSPECT_FAR],
  ] as const) {
    const list: Rock[] = [];
    if (!rocksNear(w, layer, at, at, reach, g.simTime, list, 20000)) continue;
    for (const r of list) {
      if (r.tint >= METAL_RICH || r.pos.distanceTo(at) > reach) continue;
      const make = rockMake(r);
      found.push({ id: r.id, world: w.name, size: r.size, kind: make.kind, ...rockWorth(r.size, make, kw), pos: r.pos, vel: r.vel, t0: g.simTime });
    }
  }
  return found.sort((a, b) => b.perHour - a.perHour).slice(0, PROSPECT_MAX);
}

/** The same in a trojan swarm: its metal-rich rocks (1 in 12) within PROSPECT_FAR, best first. */
function prospectSwarm(g: Game, f: TrojanField, c: ReturnType<typeof swarmCentre>): Prospect[] {
  const w = g.frameBody;
  const kw = laserFitted(g.ship.outfit)?.caps.kw ?? 600;
  const list: SwarmRock[] = [];
  swarmRocks(f, c, g.ship.pos, g.ship.pos, PROSPECT_FAR, w.pos, w.vel, list, undefined, (k) => minedRocks.get(k));
  const at = g.ship.pos.clone().sub(w.pos);
  const found: Prospect[] = [];
  for (const r of list) {
    if (r.tint >= TROJAN_METAL_RICH || r.size < 20 || r.pos.distanceTo(at) > PROSPECT_FAR) continue;
    const make = rockMake(r);
    const off = r.pos.clone().add(w.pos).sub(c.pos);
    found.push({ id: r.id, world: f.id, size: r.size, kind: make.kind, ...rockWorth(r.size, make, kw), pos: r.pos, vel: r.vel, t0: g.simTime, swarm: { off } });
  }
  return found.sort((a, b) => b.perHour - a.perHour).slice(0, PROSPECT_MAX);
}

/** Finds further than this (m) are dropped: twice the sweep's reach, well past where they were worth it. */
export const PROSPECT_FORGET = 2 * PROSPECT_FAR;

/**
 * The finds still worth marking: in the belt you're in, not mined away, and within PROSPECT_FORGET
 * (they stayed marked forever otherwise, until the next sweep). The rest are forgotten for good.
 */
export function liveProspects(g: Game) {
  const w = g.frameBody as World;
  const at = g.ship.pos.clone().sub(w.pos);
  const now = new THREE.Vector3();
  const here = swarmHere(g.cur, g.ship, w);
  g.radar.rocks = g.radar.rocks.filter((p) => {
    if (p.swarm ? here?.field.id !== p.world : p.world !== w.name) return false;
    if ((minedRocks.get(p.swarm ? swarmKey(p.id) : minedKey(w, p.id)) ?? 1) <= 0) return false;
    return prospectNow(g, p, now).distanceTo(at) < PROSPECT_FORGET;
  });
  return g.radar.rocks;
}

/** Where a find is now (planet-centred; a swarm's rock, relative to the frame body). */
export function prospectNow(g: Game, p: Prospect, pos = new THREE.Vector3(), vel = new THREE.Vector3()) {
  if (p.swarm) {
    const f = g.cur.trojans?.find((x) => x.id === p.world);
    if (f) {
      const c = swarmCentre(f);
      pos.copy(c.pos).add(p.swarm.off).sub(g.frameBody.pos);
      vel.copy(c.vel).sub(g.frameBody.vel);
      return pos;
    }
  }
  rockOn(g.frameBody.axis, p.pos, p.vel, g.simTime - p.t0, pos, vel);
  return pos;
}
