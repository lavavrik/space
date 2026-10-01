import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { atmoOf } from '../sim/atmosphere';
import { CK, cloudKindOf, deckHeight } from '../sim/cloudKind';
import { cloudCoverOf } from '../sim/clouds';
import { systemsNear } from '../universe/galaxy';
import { buildSystem } from '../universe/system';
import type { World } from '../types';

const worlds = systemsNear(new THREE.Vector3(), 40)
  .flatMap((s) => buildSystem(s))
  .filter((b): b is World => b.kind !== 'star');

describe('cloud kinds', () => {
  it('water on Earth-like and ocean worlds, dust on deserts with air, none elsewhere', () => {
    for (const b of worlds) {
      const k = cloudKindOf(b);
      if (!atmoOf(b)) expect(k).toBeNull();
      else if (b.type === WT.EarthLike || b.type === WT.Ocean) expect(k?.kind).toBe(CK.Water);
      else if (b.type === WT.Desert) expect(k?.kind).toBe(CK.Dust);
      else expect(k).toBeNull();
    }
    expect(worlds.some((b) => cloudKindOf(b)?.kind === CK.Dust)).toBe(true);
  });
  it('dust is sandy, lower than water cloud, and covers less', () => {
    const d = worlds.find((b) => cloudKindOf(b)?.kind === CK.Dust)!;
    const w = worlds.find((b) => cloudKindOf(b)?.kind === CK.Water)!;
    const c = cloudKindOf(d)!.color;
    expect(c.r).toBeGreaterThan(c.b);
    expect(deckHeight(d) / atmoOf(d)!.H).toBeLessThan(deckHeight(w) / atmoOf(w)!.H);
    for (const raw of [0, 0.15, 0.25]) expect(cloudCoverOf(d, raw)).toBeLessThan(cloudCoverOf(w, raw));
    expect(cloudCoverOf(d, 0.1)).toBe(0);
  });
});
