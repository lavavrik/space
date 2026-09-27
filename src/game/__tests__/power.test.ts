import { describe, expect, it } from 'vitest';
import { SHIP } from '../constants';
import { BATTERIES, STOCK_BATTERY, emptyOutfit, outfitMass } from '../outfit/catalog';

describe('power', () => {
  it('stock battery is 200 kWh at 5C', () => {
    expect(STOCK_BATTERY.caps.capacity).toBe(200);
    expect(STOCK_BATTERY.caps.maxKW / STOCK_BATTERY.caps.capacity).toBe(5);
    expect(outfitMass(emptyOutfit())).toBe(0); // its mass is part of the hull
  });

  it('bigger packs trade mass for power', () => {
    const o = emptyOutfit();
    o.battery = BATTERIES.find((b) => b.id === 'hp-600')!;
    expect(outfitMass(o)).toBe(7500 - 1300);
    // the HP-600 charges a hyperjump at full power
    expect(o.battery.caps.maxKW).toBeGreaterThanOrEqual(SHIP.jumpChargeKW);
  });
});
