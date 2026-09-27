import { describe, expect, it } from 'vitest';
import { ARRIVE_FLUX, AU, RSUN, SCOOP_FLUX_FULL, fluxDist } from '../constants';
import { HULL, TEMP, nextLimit } from '../sim/thermal';

const SIGMA = 5.670374e-8;
/** Where the hull settles with starlight F (Earth units) on cross-section A⊥ plus the 40 kW base load. */
const eq = (F: number, cross: number) => Math.pow((HULL.absorb * cross * F * 1361 + 40e3) / (HULL.emit * SIGMA * HULL.area), 0.25);

describe('thermal', () => {
  it('places arrival and the scoop by flux', () => {
    expect(fluxDist(1, ARRIVE_FLUX, RSUN) / AU).toBeCloseTo(0.2236, 3);
    expect(fluxDist(1, SCOOP_FLUX_FULL, RSUN) / AU).toBeCloseTo(0.1, 3);
    // a dim red dwarf: never inside 3 radii
    expect(fluxDist(1e-5, SCOOP_FLUX_FULL, 0.1 * RSUN)).toBeCloseTo(0.3 * RSUN, 0);
  });

  it('settles where the design says', () => {
    expect(eq(ARRIVE_FLUX, HULL.sideArea)).toBeGreaterThan(TEMP.warn); // don't linger side-on
    expect(eq(ARRIVE_FLUX, HULL.sideArea)).toBeLessThan(TEMP.panels);
    expect(eq(SCOOP_FLUX_FULL, HULL.endArea)).toBeLessThan(TEMP.panels); // nose-on skimming is safe
    expect(eq(SCOOP_FLUX_FULL, HULL.sideArea)).toBeGreaterThan(TEMP.drives); // side-on isn't
  });

  it('names the next limit', () => {
    expect(nextLimit(300)?.at).toBe(TEMP.warn);
    expect(nextLimit(650)?.at).toBe(TEMP.critical);
    expect(nextLimit(950)).toBeNull();
  });
});
