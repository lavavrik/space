import { describe, expect, it } from 'vitest';
import { costsOf } from '../debug/costSweep';

describe('the cost sweep\'s arithmetic', () => {
  it('takes each part\'s cost against the baseline at its time, so a drift doesn\'t read as a cost', () => {
    // the frame drifts from 10 to 12 ms over the sweep; "terrain" off saves 3 ms, "sky" nothing
    const costs = costsOf([
      { part: null, gpu: 10, t: 0 },
      { part: 'terrain', gpu: 10.5 - 3, t: 1 },
      { part: 'sky', gpu: 11, t: 2 },
      { part: null, gpu: 12, t: 4 },
    ]);
    expect(costs.map((c) => c.part)).toEqual(['terrain', 'sky']);
    expect(costs[0].ms).toBeCloseTo(3, 6);
    expect(costs[1].ms).toBeCloseTo(0, 6);
  });
});
