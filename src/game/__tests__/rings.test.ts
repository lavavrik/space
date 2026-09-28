import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { hashInts, ringDensity } from '../sim/rings';
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

  it('hashes cells the same way every time, and differently for neighbours', () => {
    expect(hashInts(1, 2, 3)).toBe(hashInts(1, 2, 3));
    expect(hashInts(1, 2, 3)).not.toBe(hashInts(1, 2, 4));
  });
});
