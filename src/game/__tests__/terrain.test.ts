import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import { homeSystem } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
import { elevationLocal, reliefAmp, snoise, terrainH, tnoise } from '../sim/terrain';
import { minOrbitAlt } from '../sim/orbits';
import type { World } from '../types';

/** Unit directions, spread evenly (Fibonacci sphere). */
function dirs(n: number) {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n,
      r = Math.sqrt(1 - y * y),
      a = i * 2.399963;
    out.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return out;
}

describe('terrain', () => {
  it('noise stays in range', () => {
    for (const [x, y, z] of dirs(500)) {
      expect(Math.abs(snoise(x * 7, y * 7, z * 7))).toBeLessThanOrEqual(1.01);
      expect(Math.abs(tnoise(x * 7, y * 7, z * 7))).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and continuous', () => {
    const a = terrainH(12.3, 0.6, 0.64, 0.48);
    expect(terrainH(12.3, 0.6, 0.64, 0.48)).toBe(a);
    // a metre over on an Earth-sized world barely moves it
    const e = 1 / 6.4e6;
    expect(Math.abs(terrainH(12.3, 0.6 + e, 0.64, 0.48) - a)).toBeLessThan(1e-3);
  });

  it('peaks stay below the lowest safe orbit', () => {
    const worlds = buildSystem(homeSystem()).filter((b): b is World => b.kind !== 'star' && reliefAmp(b) > 0);
    expect(worlds.length).toBeGreaterThan(0);
    for (const b of worlds) {
      let top = -Infinity;
      for (const [x, y, z] of dirs(3000)) top = Math.max(top, elevationLocal(b, x, y, z, 10));
      expect(top, `${b.name} (${b.type === WT.EarthLike ? 'Earth-like' : b.type})`).toBeLessThan(minOrbitAlt(b));
    }
  });
});
