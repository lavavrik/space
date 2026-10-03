import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { METAL_CATCH, TROJAN_METAL_RICH, rockMake } from '../sim/laser';
import { minedRocks } from '../sim/ringRocks';
import { SWARM_CELL, SWARM_MAX_R, SWARM_MIN_R, swarmCentre, swarmDensity, swarmHere, swarmRay, swarmRocks, swarmShapeR, vnoise, type SwarmRock } from '../sim/swarm';
import type { CurrentSystem, Ship, Star, TrojanField, World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, systemAnchor } from '../universe/system';
import { buildTrojans } from '../universe/trojans';
import { JUMP_RANGE } from '../constants';

function giantSystem() {
  for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE)) {
    const bodies = buildSystem(sys);
    updateBodies(bodies, 4e7);
    const { fields } = buildTrojans(sys, bodies);
    if (fields.some((f) => f.planet.type >= WT.GasGiant)) {
      const stars = bodies.filter((b): b is Star => b.kind === 'star');
      const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [], trojans: fields };
      return { sys, bodies, cur, field: fields.find((f) => f.planet.type >= WT.GasGiant)! };
    }
  }
  throw new Error('no giant nearby');
}
const { cur, field } = giantSystem();
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

describe('trojan fields', () => {
  it('every giant has both, and they are the same on every visit', () => {
    const { sys, bodies } = giantSystem();
    const a = buildTrojans(sys, bodies).fields;
    const b = buildTrojans(sys, bodies).fields;
    expect(a.map((f) => [f.id, f.seed, f.core])).toEqual(b.map((f) => [f.id, f.seed, f.core]));
    const w = field.planet;
    expect(a.filter((f) => f.planet.name === w.name).map((f) => f.k).sort()).toEqual([4, 5]);
  });
});

describe('swarm geometry', () => {
  it('has its centre where the planet\'s L4 or L5 is', () => {
    const w = field.planet;
    const c = swarmCentre(field);
    const lp = lagrangePoints(w)[field.k - 1];
    expect(c.pos.distanceTo(lp.pos) / w.pos.distanceTo(w.parent.pos)).toBeLessThan(1e-9);
    expect(c.vel.distanceTo(lp.vel)).toBeLessThan(1e-3);
    expect(Math.abs(c.along.dot(c.out))).toBeLessThan(1e-9);
    expect(Math.abs(c.along.dot(c.up))).toBeLessThan(1e-9);
  });

  it('is thickest at the core and gives out ~3σ off, wider along the orbit than across it', () => {
    const c = swarmCentre(field);
    const core = swarmDensity(field, c, V());
    expect(core).toBeCloseTo(field.core, 9);
    const along = swarmDensity(field, c, c.along.clone().multiplyScalar(2 * field.sigA * c.rel.length()));
    const out = swarmDensity(field, c, c.out.clone().multiplyScalar(2 * field.sigR));
    expect(along).toBeCloseTo(field.core * Math.exp(-2), 9);
    expect(out).toBeCloseTo(field.core * Math.exp(-2), 9);
    expect(swarmDensity(field, c, c.up.clone().multiplyScalar(5 * field.sigZ))).toBe(0);
    expect(field.sigA * c.rel.length()).toBeGreaterThan(field.sigR); // wider along the orbit
  });

  it('is "here" in its core and not far off', () => {
    const ship = { pos: swarmCentre(field).pos.clone() } as unknown as Ship;
    expect(swarmHere(cur, ship, field.planet.parent)?.field).toBe(field);
    ship.pos.add(V(1e12, 0, 0));
    expect(swarmHere(cur, ship, field.planet.parent)).toBeNull();
  });
});

describe('swarm rocks', () => {
  const list = (at: THREE.Vector3, reach: number, mined?: (k: string) => number | undefined) => {
    const out: SwarmRock[] = [];
    const c = swarmCentre(field);
    swarmRocks(field, c, at, at, reach, V(), V(), out, undefined, mined);
    return { out, c };
  };

  it('are deterministic, within the size range, and thick enough at the core to be worth meeting', () => {
    const c = swarmCentre(field);
    const a = list(c.pos, 24e3).out;
    const b = list(c.pos, 24e3).out;
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.length).toBeGreaterThan(5);
    expect(a.length).toBeLessThan(2000);
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length);
    for (const r of a) {
      expect(r.size0).toBeGreaterThanOrEqual(SWARM_MIN_R - 1e-6);
      expect(r.size0).toBeLessThanOrEqual(SWARM_MAX_R + 1e-6);
      expect(r.pos.distanceTo(c.pos)).toBeLessThan(24e3 + r.size0 + SWARM_CELL);
      expect(r.vel.distanceTo(c.vel)).toBeLessThan(1e-6); // co-moving with the centre
    }
  });

  it('thin out away from the core and are absent beyond it', () => {
    const c = swarmCentre(field);
    const n = (d: THREE.Vector3) => list(c.pos.clone().add(d), 24e3).out.length;
    const core = n(V());
    const far = n(c.out.clone().multiplyScalar(2.6 * field.sigR));
    expect(far).toBeLessThan(core);
    expect(n(c.up.clone().multiplyScalar(6 * field.sigZ))).toBe(0);
  });

  it('leave out what has been mined away, and shrink what has been partly mined', () => {
    const c = swarmCentre(field);
    const all = list(c.pos, 24e3).out;
    const target = all[0];
    const none = list(c.pos, 24e3, (k) => (k === target.key ? 0 : undefined)).out;
    expect(none.some((r) => r.id === target.id)).toBe(false);
    expect(none.length).toBe(all.length - 1);
    const half = list(c.pos, 24e3, (k) => (k === target.key ? 0.5 : undefined)).out.find((r) => r.id === target.id)!;
    expect(half.size).toBeCloseTo(target.size0 * 0.5, 9);
    expect(minedRocks.size).toBe(0); // (nothing leaked into the shared table)
  });

  it('are hit by a ray through them, on the drawn surface, and missed off to the side', () => {
    const c = swarmCentre(field);
    const rock = list(c.pos, 24e3).out.sort((a, b) => b.size0 - a.size0)[0];
    const from = rock.pos.clone().add(V(0, 0, -(rock.size * 6 + 500)));
    const hit = swarmRay(rock, from, V(0, 0, 1), 1e9);
    expect(hit).not.toBeNull();
    const reach = from.distanceTo(rock.pos);
    expect(hit!).toBeGreaterThan(reach - rock.size * 1.5 - 1);
    expect(hit!).toBeLessThan(reach + 1);
    // the same ray, moved clear of the rock, misses
    expect(swarmRay(rock, from.clone().add(V(rock.size * 3, 0, 0)), V(0, 0, 1), 1e9)).toBeNull();
    // and the shape stays within the bound the ray test assumes
    for (let i = 0; i < 200; i++) {
      const d = V(Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 0.3)).normalize();
      const r = swarmShapeR(d, V(i * 0.1, i * 0.2, i * 0.3));
      expect(r).toBeGreaterThan(0.4);
      expect(r).toBeLessThan(1.5);
    }
  });

  it('have a value noise in [−1, 1] that varies smoothly', () => {
    let lo = 1,
      hi = -1;
    for (let i = 0; i < 4000; i++) {
      const v = vnoise(i * 0.137, i * 0.071, i * 0.213);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(1);
    expect(Math.abs(vnoise(0.4, 0.5, 0.6) - vnoise(0.4001, 0.5, 0.6))).toBeLessThan(1e-2);
  });
});

describe('what the rocks are made of', () => {
  it('is dry rock, a tenth metal or more, and 1 in 12 a metal core', () => {
    let rich = 0;
    const N = 4000;
    let metal = 0,
      ice = 0;
    for (let i = 0; i < N; i++) {
      const id = `T:${field.id}:${i}:1:2`;
      const tint = (i % 100) / 100;
      const m = rockMake({ id, tint });
      expect(m.kind === 'rocky' || m.kind === 'nickel-iron' || m.kind === 'cobalt-rich' || m.kind === 'platinum-rich').toBe(true);
      expect(m.ice + m.rock + m.metal).toBeCloseTo(1, 9);
      expect(m.rock).toBeGreaterThan(0);
      if (tint < TROJAN_METAL_RICH) {
        rich++;
        expect(m.metal).toBeGreaterThanOrEqual(0.4);
      } else {
        expect(m.kind).toBe('rocky');
        expect(m.metal).toBeGreaterThanOrEqual(0.08);
        expect(m.metal).toBeLessThanOrEqual(0.28);
        expect(m.ice).toBeLessThanOrEqual(0.12);
      }
      metal += m.metal;
      ice += m.ice;
    }
    expect(rich / N).toBeCloseTo(TROJAN_METAL_RICH, 1);
    expect(metal / N).toBeGreaterThan(0.1);
    expect(ice / N).toBeLessThan(0.1);
    // a ring rock's metal is ~1 % of the rock: this is ten times that or more, per kg broken up
    expect(METAL_CATCH * (metal / N)).toBeGreaterThan(METAL_CATCH * 0.1);
  });
});

void homeSystem;
void ({} as World);
void ({} as TrojanField);
