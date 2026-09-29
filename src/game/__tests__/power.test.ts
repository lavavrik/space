import { describe, expect, it } from 'vitest';
import { SHIP } from '../constants';
import { BATTERIES, STOCK_BATTERY, emptyOutfit, outfitMass } from '../outfit/catalog';
import type { Game } from '../Game';
import { loadOn, loadShed } from '../sim/power';

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

  it('sheds all but life support, thrusters and FTL at a low battery, and restores them after', () => {
    const outfit = emptyOutfit();
    outfit.pumpAuto = true;
    const g = {
      ship: { batt: 50, outfit, breakers: { thrust: true, ftl: true, charge: true, radar: true, shield: true, guard: false } },
      laser: { on: true },
      lights: true,
      shed: null,
      dock: null,
      showMsg() {},
    } as unknown as Game;
    const cap = outfit.battery.caps.capacity;
    loadShed(g);
    expect(g.shed).toBeNull(); // 25 %: fine
    g.ship.batt = 0.05 * cap;
    loadShed(g);
    for (const id of ['laser', 'lights', 'radar', 'shield', 'pump'] as const) expect(loadOn(g, id)).toBe(false);
    for (const id of ['thrust', 'ftl', 'charge'] as const) expect(loadOn(g, id)).toBe(true);
    // switched back on by hand while low: left on (it acts on the crossing only)
    g.laser.on = true;
    loadShed(g);
    expect(g.laser.on).toBe(true);
    g.ship.batt = 0.35 * cap;
    loadShed(g);
    expect(g.shed).toBeNull();
    for (const id of ['lights', 'radar', 'shield', 'pump'] as const) expect(loadOn(g, id)).toBe(true);
    expect(loadOn(g, 'guard')).toBe(false); // it was off before: stays off
  });
});
