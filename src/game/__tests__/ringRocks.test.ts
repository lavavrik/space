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
