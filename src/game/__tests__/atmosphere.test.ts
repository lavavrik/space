import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { airTemp, atmoOf, GASES, makeAir, pressure } from '../sim/atmosphere';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
import { eqTemp, teq } from '../universe/worlds';
import type { World } from '../types';

const worlds = [homeSystem(), ...systemsNear(new THREE.Vector3(), 40)].flatMap((s) => buildSystem(s).filter((b): b is World => b.kind !== 'star'));
const of = (t: number) => worlds.filter((b) => b.type === t && atmoOf(b));

describe('atmospheres', () => {
  it('are the same every time for a world', () => {
    const b = of(WT.EarthLike)[0];
    const again = buildSystem(homeSystem()).find((x) => x.name === b.name) ?? b;
    expect(atmoOf(again)?.P0).toBe(atmoOf(b)?.P0);
  });

  it('gives Earth-like worlds Earth-like air', () => {
    for (const b of of(WT.EarthLike)) {
      const a = atmoOf(b)!;
      expect(a.rho0).toBeGreaterThan(0.4);
      expect(a.rho0).toBeLessThan(12); // (far out in the habitable zone, bars of CO₂)
      expect(a.Ts - b.T).toBeGreaterThan(5); // a greenhouse effect, not a runaway
      expect(a.Ts - b.T).toBeLessThan(150);
      expect(a.gases.map(([gas]) => gas)).toEqual(expect.arrayContaining(['N₂', 'O₂', 'H₂O', 'CO₂']));
    }
  });

  it('keeps living worlds temperate, with more CO₂ the less light they get', () => {
    const living = [...of(WT.EarthLike), ...of(WT.Ocean)];
    const co2 = (b: World) => (atmoOf(b)!.gases.find(([gas]) => gas === 'CO₂')![1] * atmoOf(b)!.P0) / 1e5;
    for (const b of living) {
      const Ts = atmoOf(b)!.Ts;
      expect(Ts).toBeGreaterThan(273); // liquid water
      expect(Ts).toBeLessThan(350); // warm by the inner edge, never boiling
    }
    // the carbonate–silicate cycle: dim worlds build up CO₂, bright ones draw it down to a trace
    const dim = living.filter((b) => b.T < 215),
      bright = living.filter((b) => b.T > 250);
    const mean = (xs: World[]) => xs.reduce((s, b) => s + co2(b), 0) / xs.length;
    expect(mean(dim)).toBeGreaterThan(0.5);
    expect(mean(bright)).toBeLessThan(0.05);
  });

  it('warms an Earth twin to about 15 °C, with Earth-like CO₂', () => {
    // 1 AU from the Sun: 255 K with its albedo; 1 bar of N₂/O₂, 0.6 % water vapour
    const T = eqTemp(teq(1, 1), 0.3);
    expect(Math.abs(T - 255)).toBeLessThan(1);
    let u = 0;
    const r = () => [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][u++ % 8];
    const air = makeAir(WT.EarthLike, T, r)!;
    const tau = air.bar * (0.5 + air.gases.reduce((s, [gas, x]) => s + x * GASES[gas].ir, 0));
    const Ts = T * Math.pow(1 + 0.75 * tau, 0.25);
    expect(Ts - 273.15).toBeGreaterThan(10);
    expect(Ts - 273.15).toBeLessThan(20);
    expect(air.gases.find(([gas]) => gas === 'CO₂')![1]).toBeLessThan(0.002);
  });

  it('makes hot volcanic worlds crushing and cold volcanic moons thin', () => {
    for (const b of of(WT.Volcanic)) {
      const a = atmoOf(b)!;
      if (b.T >= 300) expect(a.P0 / 1e5).toBeGreaterThan(19);
      else expect(a.P0 / 1e5).toBeLessThan(0.06);
    }
  });

  it('thins out and cools with height', () => {
    const a = atmoOf(of(WT.EarthLike)[0])!;
    expect(pressure(a, a.H)).toBeCloseTo(a.P0 / Math.E, 0);
    expect(airTemp(a, 0)).toBeCloseTo(a.Ts);
    expect(airTemp(a, 10 * a.H)).toBeLessThan(a.Ts);
  });
});
