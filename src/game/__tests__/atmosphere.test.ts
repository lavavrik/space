import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { airTemp, atmoOf, pressure } from '../sim/atmosphere';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
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
      expect(a.rho0).toBeLessThan(3);
      expect(a.Ts - b.T).toBeGreaterThan(5); // a greenhouse effect, not a runaway
      expect(a.Ts - b.T).toBeLessThan(80);
      expect(a.gases[0][0]).toBe('N₂');
    }
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
