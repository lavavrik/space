import { describe, expect, it } from 'vitest';
import { heatDamageRate, impactDamage } from '../sim/damage';
import { TEMP } from '../sim/thermal';

describe('hull damage', () => {
  it('impacts: nothing under the scrape speed, a whole hull at the fatal one, growing like energy between', () => {
    expect(impactDamage(8, 10, 150)).toBe(0);
    expect(impactDamage(150, 10, 150)).toBeCloseTo(1, 9);
    expect(impactDamage(80, 10, 150)).toBeCloseTo(0.25, 9);
    // a gentle bump barely scratches; twice the excess speed, four times the damage
    expect(impactDamage(12, 10, 150)).toBeLessThan(0.001);
    expect(impactDamage(50, 10, 150) / impactDamage(30, 10, 150)).toBeCloseTo(4, 9);
  });

  it('heat: none up to critical, 3 %/s at the failure point', () => {
    expect(heatDamageRate(TEMP.critical)).toBe(0);
    expect(heatDamageRate(TEMP.fail)).toBeCloseTo(0.03, 9);
    expect(heatDamageRate((TEMP.critical + TEMP.fail) / 2)).toBeCloseTo(0.0075, 9);
  });
});

describe('ring dust', () => {
  it('wears nothing below DUST_V, grows with the cube of the excess, scales with density', async () => {
    const { dustRate, DUST_V } = await import('../sim/belt');
    expect(dustRate(DUST_V, 1)).toBe(0);
    expect(dustRate(800, 1) * 60).toBeGreaterThan(0.005); // ~0.6 %/min at the belt limit
    expect(dustRate(800, 1) * 60).toBeLessThan(0.01);
    expect(dustRate(3500, 1)).toBeCloseTo(0.108, 3);
    expect(dustRate(2500, 0.5) / dustRate(2500, 1)).toBeCloseTo(0.5, 9);
  });
});
