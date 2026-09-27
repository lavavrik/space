import { describe, expect, it } from 'vitest';
import { MODULES, emptyOutfit, moduleById, outfitMass, radiatorArea } from '../outfit/catalog';
import { VENT, ventHeatPerKg } from '../sim/thermal';

describe('outfit', () => {
  it('adds up mass and deployed radiator area', () => {
    const o = emptyOutfit();
    expect(outfitMass(o)).toBe(0);
    o.slots[0] = moduleById('kr-25');
    o.slots[1] = moduleById('kh-2');
    expect(outfitMass(o)).toBe(3500 + 1200);
    expect(radiatorArea(o)).toBe(0); // stowed
    o.radiatorsOut = 0.5;
    expect(radiatorArea(o)).toBe(1250);
  });

  it('has unique ids', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
  });

  it('vents about 8 kg/s of hydrogen at a hot hull', () => {
    const flow = VENT.maxW / ventHeatPerKg(500);
    expect(flow).toBeGreaterThan(6);
    expect(flow).toBeLessThan(11);
  });
});

describe('fuel scoops', () => {
  it('picks the best fitted scoop', async () => {
    const { scoopFitted } = await import('../outfit/catalog');
    const o = emptyOutfit();
    expect(scoopFitted(o)).toBeNull(); // none by default
    o.slots[0] = moduleById('fs-1');
    o.slots[1] = moduleById('fs-3');
    expect(scoopFitted(o)?.id).toBe('fs-3'); // the exotic-capable one wins
  });
});
