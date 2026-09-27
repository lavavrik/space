import { describe, expect, it } from 'vitest';
import { AU } from '../constants';
import { RADAR_KW, RADAR_RANGE, radarClass } from '../sim/radar';
import type { Target } from '../types';

describe('radar', () => {
  it('reaches 10 AU and costs power', () => {
    expect(RADAR_RANGE).toBe(10 * AU);
    expect(RADAR_KW).toBeGreaterThan(0);
  });

  it('only tells the broad class', () => {
    expect(radarClass({ kind: 'station' } as Target)).toBe('station');
    expect(radarClass({ kind: 'moon' } as Target)).toBe('moon');
    expect(radarClass({ kind: 'planet', type: 6 } as Target)).toBe('gas giant');
    expect(radarClass({ kind: 'planet', type: 7 } as Target)).toBe('ice giant');
    expect(radarClass({ kind: 'planet', type: 2 } as Target)).toBe('rocky world');
  });
});
