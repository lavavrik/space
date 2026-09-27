import { describe, expect, it } from 'vitest';
import { SCANNERS } from '../avionics/catalog';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { resolvable } from '../sim/scanner';
import type { Target } from '../types';

/** Just enough of a Game for the resolution check. */
const fakeGame = (scannerIdx: number) => ({ ship: { pos: new THREE.Vector3(), avionics: { scanner: SCANNERS[scannerIdx] } } }) as unknown as Game;
const station = (d: number) => ({ kind: 'station', size: 1000, radius: 866, pos: new THREE.Vector3(d, 0, 0) }) as unknown as Target;
const planet = (d: number) => ({ kind: 'planet', radius: 6.371e6, pos: new THREE.Vector3(d, 0, 0) }) as unknown as Target;
const AU = 1.496e11;

describe('scanner resolution', () => {
  it('matches the catalogue: a 1 km station from ~3,400 km / ~41,000 km / ~1 million km', () => {
    for (const [i, need] of [[0, 3.44e6], [1, 4.13e7], [2, 1.03e9]]) {
      const r = resolvable(fakeGame(i), station(1e3));
      expect(r.needDist / need).toBeGreaterThan(0.95);
      expect(r.needDist / need).toBeLessThan(1.05);
      expect(resolvable(fakeGame(i), station(need * 0.9)).ok).toBe(true);
      expect(resolvable(fakeGame(i), station(need * 1.1)).ok).toBe(false);
    }
  });

  it('resolves an Earth-size planet out to ~0.3 AU with the basic unit, across the system with the best', () => {
    expect(resolvable(fakeGame(0), planet(0.25 * AU)).ok).toBe(true);
    expect(resolvable(fakeGame(0), planet(0.35 * AU)).ok).toBe(false);
    expect(resolvable(fakeGame(2), planet(30 * AU)).ok).toBe(true);
  });
});
