import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { homeSystem } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
import type { World } from '../types';
import { effectiveSpeed, ringAxes, rockMass, rocksNear, sweepRocks, type Rock } from '../sim/ringRocks';

const bodies = buildSystem(homeSystem());
const w = bodies.find((b): b is World => b.kind !== 'star' && !!b.ring)!;
const { e1 } = ringAxes(w.axis);
const at = e1.clone().multiplyScalar(w.radius * (w.ring!.inner * 0.5 + w.ring!.outer * 0.5));

describe('ring rocks (CPU replica of the GPU generator)', () => {
  it('finds rocks around a point in the belt, the same ones every time, orbiting with their bin', () => {
    const a: Rock[] = [],
      b: Rock[] = [];
    rocksNear(w, 1, at, at, 2000, 1234.5, a);
    rocksNear(w, 1, at, at, 2000, 1234.5, b);
    expect(a.length).toBeGreaterThan(10);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    for (const r of a) {
      expect(r.size).toBeGreaterThanOrEqual(10);
      expect(r.size).toBeLessThanOrEqual(70);
      // circular: speed ω r, perpendicular to the radius, in the ring's plane
      expect(r.vel.dot(r.pos)).toBeCloseTo(0, 3);
      expect(Math.abs(r.vel.dot(w.axis))).toBeLessThan(1e-6);
    }
    // later, the same rock has moved along its orbit
    const later: Rock[] = [];
    const r0 = a[0];
    const guess = r0.pos.clone().addScaledVector(r0.vel, 0.5);
    rocksNear(w, 1, guess, guess, 500, 1235, later);
    const r1 = later.find((r) => r.id === r0.id)!;
    expect(r1.pos.distanceTo(r0.pos.clone().addScaledVector(r0.vel, 0.5))).toBeLessThan(1);
  });

  it('a sweep through a rock hits it; one beside it misses', () => {
    const list: Rock[] = [];
    rocksNear(w, 1, at, at, 3000, 0, list);
    const rock = list.reduce((m, r) => (r.size > m.size ? r : m));
    // co-moving with it (so its motion over the step doesn't matter), straight through its centre
    const dt = 0.05;
    const across = new THREE.Vector3().crossVectors(w.axis, rock.pos).normalize();
    const a = rock.pos.clone().addScaledVector(rock.vel, -dt).addScaledVector(w.axis, -200);
    const b = rock.pos.clone().addScaledVector(w.axis, 200);
    const hit = sweepRocks(w, a, b, dt, 0, 6);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeGreaterThan(0);
    expect(hit!.t).toBeLessThan(0.5);
    const off = across.multiplyScalar(rock.size + 500);
    expect(sweepRocks(w, a.clone().add(off), b.clone().add(off), dt, 0, 6)?.rock.id === rock.id).toBe(false);
  });

  it('a pebble hurts by the reduced mass; a boulder like the ground', () => {
    const ship = 150e3;
    expect(effectiveSpeed(100, rockMass(2), ship)).toBeLessThan(40);
    expect(effectiveSpeed(100, rockMass(300), ship)).toBeGreaterThan(99);
  });
});

describe('ring rock make-up', () => {
  it('is 90–99 % water ice, the same for the same rock', async () => {
    const { rockIce } = await import('../sim/laser');
    const ids = Array.from({ length: 200 }, (_, i) => `1:${1000 + i}:${i * 7}:0`);
    for (const id of ids) {
      expect(rockIce(id)).toBeGreaterThanOrEqual(0.9);
      expect(rockIce(id)).toBeLessThanOrEqual(0.99);
      expect(rockIce(id)).toBe(rockIce(id));
    }
    expect(new Set(ids.map(rockIce)).size).toBeGreaterThan(150);
  });
});

describe('ring rock shapes and mining', () => {
  it("a ray meets a rock's drawn surface between its squashed and its lumpy extent, and misses beside it", async () => {
    const { rockRay } = await import('../sim/ringRocks');
    const list: Rock[] = [];
    rocksNear(w, 1, at, at, 3000, 0, list);
    for (const rock of list.slice(0, 20)) {
      const from = rock.pos.clone().addScaledVector(w.axis, rock.size * 5);
      const dir = w.axis.clone().negate();
      const t = rockRay(rock, from, dir, rock.size * 10);
      expect(t).not.toBeNull();
      const depth = rock.size * 5 - t!; // how far out from the centre it hit
      expect(depth).toBeGreaterThan(rock.size * 0.2);
      expect(depth).toBeLessThan(rock.size * 1.5);
      const beside = from.clone().add(new THREE.Vector3().crossVectors(w.axis, rock.pos).normalize().multiplyScalar(rock.size * 1.6));
      expect(rockRay(rock, beside, dir, rock.size * 10)).toBeNull();
    }
  });

  it('a mined rock is smaller, and a mined-away one is gone', async () => {
    const { minedRocks, minedKey } = await import('../sim/ringRocks');
    const list: Rock[] = [];
    rocksNear(w, 1, at, at, 2000, 0, list);
    const [a, b] = list;
    minedRocks.set(minedKey(w, a.id), 0.5);
    minedRocks.set(minedKey(w, b.id), 0);
    const again: Rock[] = [];
    rocksNear(w, 1, at, at, 2000, 0, again);
    expect(again.find((r) => r.id === a.id)!.size).toBeCloseTo(a.size * 0.5, 9);
    expect(again.find((r) => r.id === b.id)).toBeUndefined();
    minedRocks.clear();
  });

  it('one rock in ~33 is metal-rich, mostly nickel-iron, rarely platinum-rich, and worth far more', async () => {
    const { rockMake } = await import('../sim/laser');
    const { rockWorth } = await import('../sim/prospect');
    const list: Rock[] = [];
    rocksNear(w, 1, at, at, 6000, 0, list, 20000);
    const makes = list.map((r) => rockMake(r));
    const rich = makes.filter((m) => m.kind !== 'icy');
    expect(list.length).toBeGreaterThan(500);
    expect(rich.length / list.length).toBeGreaterThan(0.015);
    expect(rich.length / list.length).toBeLessThan(0.05);
    for (const m of makes) {
      expect(m.ice + m.rock + m.metal).toBeCloseTo(1);
      expect(m.mix.nife + m.mix.cobalt + m.mix.pgm).toBeCloseTo(1);
    }
    // the same rock is the same every time (a hash of its id and tint)
    expect(rockMake(list[0])).toEqual(rockMake(list[0]));
    // per kg of metal: platinum-rich > cobalt-rich > nickel-iron
    const perKg = (kind: string) => {
      const m = makes.find((x) => x.kind === kind);
      return m ? rockWorth(10, m, 600).perKg : null;
    };
    const [fe, co, pt] = [perKg('nickel-iron'), perKg('cobalt-rich'), perKg('platinum-rich')];
    if (fe && co) expect(co).toBeGreaterThan(fe);
    if (co && pt) expect(pt).toBeGreaterThan(co);
    // a metal-rich rock holds ~10× the metal of an icy one its size
    const icy = makes.find((m) => m.kind === 'icy')!;
    expect(rockWorth(10, rich[0], 600).metalKg).toBeGreaterThan(5 * rockWorth(10, icy, 600).metalKg);
  });
});
