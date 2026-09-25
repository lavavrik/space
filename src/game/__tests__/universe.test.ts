import { describe, expect, it } from 'vitest';
import { SYSTEM_COUNT, WT } from '../constants';
import { mulberry32 } from '../lib/rng';
import { getGalaxy } from '../universe/galaxy';
import { buildSystem, findHome } from '../universe/system';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(42),
      b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});

describe('galaxy', () => {
  const systems = getGalaxy();

  it('has every system with a unique name', () => {
    expect(systems).toHaveLength(SYSTEM_COUNT);
    expect(new Set(systems.map((s) => s.name)).size).toBe(SYSTEM_COUNT);
  });

  it('is the same galaxy on every visit', () => {
    // pinned so a refactor can't silently reshuffle the universe
    expect(systems[0].name).toBe('Venydes');
    expect(systems[0].star.spec).toBe('G4 V');
    const bodies = buildSystem(systems[0]);
    expect(bodies.map((b) => b.name)).toEqual(buildSystem(systems[0]).map((b) => b.name));
  });

  it('starts at a Sun-like home star with an Earth-like world and a moon', () => {
    const home = systems[0];
    expect(home.star.cls).toBe('G');
    const bodies = buildSystem(home);
    const planet = findHome(bodies);
    expect(planet?.kind).toBe('planet');
    expect(planet && planet.kind !== 'star' && planet.type).toBe(WT.EarthLike);
    expect(bodies.some((b) => b.kind === 'moon' && b.parent === planet)).toBe(true);
  });

  it('builds physically sensible systems', () => {
    for (const sys of systems.slice(0, 20)) {
      const bodies = buildSystem(sys);
      expect(bodies[0].kind).toBe('star');
      for (const b of bodies.slice(1)) {
        expect(b.kind === 'star').toBe(false);
        if (b.kind === 'star') continue;
        expect(b.radius).toBeGreaterThan(0);
        expect(b.mu).toBeGreaterThan(0);
        // a body's sphere of influence sits well inside its orbit
        expect(b.soi).toBeLessThan(b.orbit);
        expect(b.axis.length()).toBeCloseTo(1, 9);
      }
    }
  });
});
