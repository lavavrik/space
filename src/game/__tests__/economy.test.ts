import { describe, expect, it } from 'vitest';
import { SHIP } from '../constants';
import type { Game } from '../Game';
import { CARGO_CAP, buyFuelTo, fuelPrice, buyFuel, buyRepair, cargoMass, jettison, refuelQuote, sellCargo, sellOne, sellPrice, stationFactor, stowMetal } from '../sim/economy';
import type { Station } from '../types';

const station = (name: string) => ({ name }) as Station;
/** Just what the economy touches. */
function fake(credits: number): Game {
  return {
    credits,
    ship: { prop: 0, exotic: 0, hull: 1, cargo: {} },
    dock: { docked: true, station: station('Test Port'), pad: 0 },
    warned: {},
    showMsg() {},
  } as unknown as Game;
}

describe('economy', () => {
  it('prices vary by station, ±20 %, the same every visit', () => {
    const fs = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => stationFactor(station(`${n} Hub`), 'prop'));
    for (const f of fs) {
      expect(f).toBeGreaterThanOrEqual(0.8);
      expect(f).toBeLessThanOrEqual(1.2);
    }
    expect(new Set(fs).size).toBeGreaterThan(3);
    expect(stationFactor(station('A Hub'), 'prop')).toBe(fs[0]);
  });

  it('refuelling fills the tanks for the quoted price, or as far as the credits go', () => {
    const g = fake(1e6);
    const q = refuelQuote(g, g.dock!.station);
    buyFuel(g);
    expect(g.ship.prop).toBeCloseTo(SHIP.propCap, 6);
    expect(g.ship.exotic).toBeCloseTo(SHIP.exoticCap, 6);
    expect(1e6 - g.credits).toBeCloseTo(q.cost, 3);
    const poor = fake(1000);
    buyFuel(poor);
    expect(poor.credits).toBeCloseTo(0, 6);
    expect(poor.ship.prop).toBeGreaterThan(0);
    expect(poor.ship.prop).toBeLessThan(SHIP.propCap);
  });

  it('repairs as far as the credits go', () => {
    const g = fake(500);
    g.ship.hull = 0.5;
    buyRepair(g);
    expect(g.credits).toBeCloseTo(0, 6);
    expect(g.ship.hull).toBeGreaterThan(0.5);
    expect(g.ship.hull).toBeLessThan(0.6);
  });

  it('the hold takes metal up to its capacity; selling empties it for credits', () => {
    const g = fake(0);
    expect(stowMetal(g, 5000)).toBe(5000);
    expect(stowMetal(g, CARGO_CAP)).toBeCloseTo(CARGO_CAP - 5000, 6);
    expect(cargoMass(g)).toBeCloseTo(CARGO_CAP, 6);
    sellCargo(g);
    expect(cargoMass(g)).toBe(0);
    expect(g.credits).toBeGreaterThan(CARGO_CAP * 0.2);
  });

  it('sells one metal at a time, and jettisons without pay', () => {
    const g = fake(0);
    stowMetal(g, 10_000);
    sellOne(g, 'pgm');
    expect(g.ship.cargo.pgm).toBeUndefined();
    expect(g.credits).toBeCloseTo(100 * sellPrice(g.dock!.station, 'pgm'));
    expect(cargoMass(g)).toBeCloseTo(9_900);
    jettison(g, 'nife');
    expect(g.ship.cargo.nife).toBeUndefined();
    expect(cargoMass(g)).toBeCloseTo(900);
    expect(g.credits).toBeCloseTo(100 * sellPrice(g.dock!.station, 'pgm'));
  });

  it("stows metal by the rock's own mix", () => {
    const g = fake(0);
    stowMetal(g, 1000, { nife: 0.8, cobalt: 0.1, pgm: 0.1 });
    expect(g.ship.cargo.pgm).toBeCloseTo(100);
    expect(g.ship.cargo.nife).toBeCloseTo(800);
  });

  it('buys one fuel up to a level, leaving the other, as far as the credits go', () => {
    const g = fake(1_000_000);
    buyFuelTo(g, 'prop', 50_000);
    expect(g.ship.prop).toBeCloseTo(50_000);
    expect(g.ship.exotic).toBe(0);
    expect(g.credits).toBeCloseTo(1_000_000 - 50_000 * fuelPrice(g.dock!.station, 'prop'));
    buyFuelTo(g, 'prop', 40_000); // below what's in the tank: nothing
    expect(g.ship.prop).toBeCloseTo(50_000);
    const poor = fake(600);
    buyFuelTo(poor, 'exotic', SHIP.exoticCap);
    expect(poor.credits).toBeCloseTo(0);
    expect(poor.ship.exotic).toBeCloseTo(600 / fuelPrice(poor.dock!.station, 'exotic'));
  });
});
