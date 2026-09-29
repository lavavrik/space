import { describe, expect, it } from 'vitest';
import { SHIP } from '../constants';
import type { Game } from '../Game';
import { BATTERIES, emptyOutfit, moduleById } from '../outfit/catalog';
import { FC_KWH, H2_IN_WATER, LIFE_O2, O2_PER_H2, SPLIT_KWH, WATER_PER_H2, breathe, cryo, fuelCellOffer, gatherO2, settleFuelCell } from '../sim/oxygen';

/** Just what oxygen touches: a stock-battery ship with an FC-150. */
function fake(batt: number): Game {
  const outfit = emptyOutfit();
  outfit.battery = BATTERIES[0]; // 200 kWh
  outfit.slots[0] = moduleById('fc-150');
  return {
    ship: { batt, prop: 50_000, o2: SHIP.o2Cap, water: 0, temp: 290, outfit, mode: 'normal', breakers: { fuelcell: true, electrolysis: true, cryo: true } },
    power: { solar: 0, shore: 0, draw: 100, fcOn: false, fcOffer: 0, fcKW: 0, electrolysisKW: 0, cryoKW: 0, left: 1000, limited: null },
    aero: { body: null, rho: 0, speed: 0 },
    dock: null,
    warned: {},
    showMsg() {},
  } as unknown as Game;
}

describe('oxygen', () => {
  it('the fuel cell starts under 30 %, stops over 80 %, and burns H₂ and O₂ in proportion to what it gives', () => {
    const g = fake(100); // 50 %: not yet
    expect(fuelCellOffer(g)).toBe(0);
    g.ship.batt = 50; // 25 %
    expect(fuelCellOffer(g)).toBe(150);
    const [h2, o2] = [g.ship.prop, g.ship.o2];
    const kw = settleFuelCell(g, 3600, 150); // an hour: the 100 kW loads plus 50 more into the battery (its rating)
    expect(kw).toBe(150);
    expect(h2 - g.ship.prop).toBeCloseTo(150 / FC_KWH);
    expect(o2 - g.ship.o2).toBeCloseTo((150 / FC_KWH) * O2_PER_H2);
    g.ship.batt = 170; // 85 %
    expect(fuelCellOffer(g)).toBe(0);
  });

  it('the fuel cell is limited by the oxygen left', () => {
    const g = fake(20);
    fuelCellOffer(g);
    g.ship.o2 = 10;
    settleFuelCell(g, 3600, 150);
    expect(g.ship.o2).toBeCloseTo(0);
    expect(g.power.fcKW).toBeCloseTo((10 / O2_PER_H2) * FC_KWH);
  });

  it('life support breathes 2 kg a day, not while docked, and an empty tank is fatal', () => {
    const g = fake(100);
    breathe(g, 86400);
    expect(SHIP.o2Cap - g.ship.o2).toBeCloseTo(2);
    g.dock = { docked: true } as Game['dock'];
    breathe(g, 86400);
    expect(SHIP.o2Cap - g.ship.o2).toBeCloseTo(2);
    g.dock = null;
    g.ship.o2 = LIFE_O2 / 2;
    expect(breathe(g, 1)).toBe(true);
  });

  it('the fuel cell keeps its water; the electrolyser splits it back on spare power, never from a battery under half or while the cell runs', () => {
    const g = fake(20);
    fuelCellOffer(g);
    settleFuelCell(g, 3600, 150);
    const h2 = 150 / FC_KWH;
    expect(g.ship.water).toBeCloseTo(h2 * WATER_PER_H2);
    // the cell is still on: no splitting
    expect(gatherO2(g, 3600, false)).toBe(0);
    const s = fake(150);
    s.ship.o2 = 0;
    s.ship.water = 1000;
    const rate = gatherO2(s, 3600, false);
    expect(s.power.electrolysisKW).toBe(300);
    const split = 300 / SPLIT_KWH;
    expect(1000 - s.ship.water).toBeCloseTo(split);
    expect(rate * 3600).toBeCloseTo(split * (1 - H2_IN_WATER));
    expect(s.ship.prop - 50_000).toBeCloseTo(split * H2_IN_WATER);
    const low = fake(80);
    low.ship.o2 = 0;
    low.ship.water = 1000;
    expect(gatherO2(low, 3600, false)).toBe(0);
  });

  it('the cryocoolers hold the tanks cold for ~7 kW; switched off, they boil off slowly', () => {
    const g = fake(150);
    const boil = cryo(g, 86400);
    expect(g.power.cryoKW).toBeGreaterThan(5);
    expect(g.power.cryoKW).toBeLessThan(10);
    expect(boil.prop).toBe(0);
    g.ship.breakers.cryo = false;
    const p0 = g.ship.prop;
    cryo(g, 86400);
    const perDay = p0 - g.ship.prop;
    expect(perDay).toBeGreaterThan(5); // ~16 kg of hydrogen a day at a 290 K hull
    expect(perDay).toBeLessThan(40);
  });
});
