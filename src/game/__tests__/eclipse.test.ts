import { describe, expect, it } from 'vitest';
import { discCover } from '../sim/eclipse';

describe('eclipse', () => {
  const aS = 0.01;
  it('covers nothing past first contact and all of the star behind a bigger disc', () => {
    expect(discCover(aS, 0.02, 0.031)).toBe(0);
    expect(discCover(aS, 0.02, 0)).toBe(1);
  });
  it('leaves an annulus lit behind a smaller disc (the covered share is its area)', () => {
    expect(discCover(aS, 0.005, 0)).toBeCloseTo(0.25, 5);
  });
  it('fades smoothly through the penumbra', () => {
    const a = discCover(aS, 0.02, 0.025),
      b = discCover(aS, 0.02, 0.015);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });
});
