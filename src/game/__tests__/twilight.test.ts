import { describe, expect, it } from 'vitest';
import { OVERCAST_K, TWILIGHT_K, overcastBoost, twilightBoost } from '../render/exposure';

const sin = (deg: number) => Math.sin((deg * Math.PI) / 180);

describe('twilightBoost', () => {
  it('leaves day and deep night alone', () => {
    expect(twilightBoost(sin(30), 0)).toBe(1);
    expect(twilightBoost(sin(-20), 0)).toBe(1);
  });
  it('brightens the blue hour, in the air only', () => {
    expect(twilightBoost(sin(-5), 0)).toBeCloseTo(TWILIGHT_K);
    expect(twilightBoost(sin(-5), 6)).toBe(1);
    expect(twilightBoost(sin(0), 0)).toBeGreaterThan(1);
    expect(twilightBoost(sin(0), 0)).toBeLessThan(TWILIGHT_K);
  });
});

describe('overcastBoost', () => {
  it('brightens under thick cover, below the cloud base only', () => {
    expect(overcastBoost(0.2, 1)).toBe(1);
    expect(overcastBoost(0.9, 1)).toBeCloseTo(OVERCAST_K);
    expect(overcastBoost(0.9, 0)).toBe(1);
  });
});
