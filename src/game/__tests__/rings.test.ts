import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { ringDensity } from '../sim/rings';
import { evalPlan, orbitNormal } from '../sim/orbits';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
import type { World } from '../types';

const ringed = [homeSystem(), ...systemsNear(new THREE.Vector3(), 40)].flatMap((s) => buildSystem(s).filter((b): b is World => b.kind !== 'star' && !!b.ring)).slice(0, 20);

describe('rings', () => {
  it('have rocks only within the ring, and none in the division', () => {
    expect(ringed.length).toBeGreaterThan(0);
    for (const b of ringed) {
      const { inner, outer } = b.ring!;
      expect(ringDensity(b, inner * 0.99)).toBe(0);
      expect(ringDensity(b, outer * 1.01)).toBe(0);
      expect(ringDensity(b, inner + 0.63 * (outer - inner))).toBe(0); // the Cassini-like gap
      let peak = 0;
      for (let t = 0.05; t < 0.95; t += 0.01) peak = Math.max(peak, ringDensity(b, inner + t * (outer - inner)));
      expect(peak).toBeGreaterThan(0.2);
      expect(peak).toBeLessThanOrEqual(0.85);
    }
  });


  it('plans ring orbits inside the ring, in its plane, going its way', () => {
    const b = ringed[0];
    const ship = { prop: 1e5, outfit: { slots: [], battery: { mass: 0 } } } as never;
    const inside = evalPlan({ body: b, type: 'ring', alt: (b.ring!.inner + 0.3 * (b.ring!.outer - b.ring!.inner) - 1) * b.radius, dir: -1, curAlt: 0 }, ship);
    expect(inside.ok).toBe(true);
    const tooLow = evalPlan({ body: b, type: 'ring', alt: 0, dir: 1, curAlt: 0 }, ship);
    expect(tooLow.r0).toBeCloseTo(b.ring!.inner * b.radius, -3); // clamped to the inner edge
    const n = orbitNormal(b, 'ring', -1, new THREE.Vector3(1, 0, 0));
    expect(n.dot(b.axis)).toBeCloseTo(1); // prograde whatever the direction setting
  });
});
