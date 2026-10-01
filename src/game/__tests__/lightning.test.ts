import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { BOLT_POINTS, LIFE, boltPath, strikeGlow } from '../sim/lightning';

describe('lightning', () => {
  it('flickers through its strokes and is gone after LIFE', () => {
    expect(strikeGlow(0)).toBeCloseTo(1);
    expect(strikeGlow(0.06)).toBeLessThan(0.3);
    expect(strikeGlow(0.09)).toBeCloseTo(0.7);
    expect(strikeGlow(LIFE + 0.01)).toBe(0);
    expect(strikeGlow(-0.01)).toBe(0);
  });
  it('runs from the cloud base to the ground, with branches, within the point budget', () => {
    const s = { body: {} as never, groundRel: new THREE.Vector3(), topRel: new THREE.Vector3(), ground: new THREE.Vector3(0, 0, 0), top: new THREE.Vector3(0, 5000, 0), t0: 0, seed: 12.5 };
    const p = boltPath(s);
    expect(p.length).toBeLessThanOrEqual(BOLT_POINTS);
    expect(p[0].p.distanceTo(s.top)).toBeLessThan(1);
    expect(p[22].p.distanceTo(s.ground)).toBeLessThan(1);
    expect(p.filter((x) => x.start).length).toBeGreaterThanOrEqual(3);
  });
});
