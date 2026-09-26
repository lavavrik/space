import { describe, expect, it } from 'vitest';
import { JUMP_RANGE, SECTOR_SIZE, STARS_IN_RANGE, WT } from '../constants';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import { generateSector, HOME_ID, homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, findHome } from '../universe/system';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(42),
      b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});

describe('galaxy', () => {
  const origin = new THREE.Vector3();
  const home = homeSystem();

  it('is the same galaxy on every visit', () => {
    // pinned so a refactor can't silently reshuffle the universe
    expect(home.name).toBe('Venydes');
    expect(home.star.spec).toBe('G4 V');
    expect(home.pos.length()).toBe(0);
    const bodies = buildSystem(home);
    expect(bodies.map((b) => b.name)).toEqual(buildSystem(home).map((b) => b.name));
    // sectors are pure functions of their coordinates
    for (const [x, y, z] of [[0, 0, 0], [3, -1, 7], [-120, 40, 999]]) {
      const a = generateSector(x, y, z),
        b = generateSector(x, y, z);
      expect(a.map((s) => [s.id, s.name, s.seed, s.pos.toArray()])).toEqual(b.map((s) => [s.id, s.name, s.seed, s.pos.toArray()]));
    }
  });

  it('puts home at the origin, inside sector 0,0,0', () => {
    expect(home.id).toBe(HOME_ID);
    expect(generateSector(0, 0, 0)[0]).toBe(home);
    expect(systemsNear(origin, 1)).toContain(home);
  });

  it('keeps sector stars inside their sector', () => {
    const h = SECTOR_SIZE / 2;
    for (const [x, y, z] of [[1, 2, 3], [-4, 0, 9], [50, -50, 50]]) {
      for (const s of generateSector(x, y, z)) {
        expect(Math.abs(s.pos.x - x * SECTOR_SIZE)).toBeLessThanOrEqual(h);
        expect(Math.abs(s.pos.y - y * SECTOR_SIZE)).toBeLessThanOrEqual(h);
        expect(Math.abs(s.pos.z - z * SECTOR_SIZE)).toBeLessThanOrEqual(h);
      }
    }
  });

  it('finds exactly the systems within a radius', () => {
    const c = new THREE.Vector3(13.3, -7.1, 42);
    const inner = systemsNear(c, JUMP_RANGE);
    const brute = systemsNear(c, JUMP_RANGE + 20).filter((s) => s.pos.distanceTo(c) <= JUMP_RANGE);
    expect(new Set(inner.map((s) => s.id))).toEqual(new Set(brute.map((s) => s.id)));
    expect(new Set(inner.map((s) => s.id)).size).toBe(inner.length);
  });

  it('has about 100 ± 20 systems within jump range anywhere', () => {
    const g = mulberry32(7);
    let total = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const c = new THREE.Vector3(rr(g, -3000, 3000), rr(g, -3000, 3000), rr(g, -3000, 3000));
      const n = systemsNear(c, JUMP_RANGE).length;
      expect(n).toBeGreaterThanOrEqual(STARS_IN_RANGE - 20);
      expect(n).toBeLessThanOrEqual(STARS_IN_RANGE + 20);
      total += n;
    }
    expect(Math.abs(total / N - STARS_IN_RANGE)).toBeLessThan(5);
  });

  it('rarely repeats a name within jump range', () => {
    const near = systemsNear(origin, JUMP_RANGE);
    expect(new Set(near.map((s) => s.name)).size).toBeGreaterThanOrEqual(near.length - 1);
  });

  it('starts at a Sun-like home star with an Earth-like world and a moon', () => {
    expect(home.star.cls).toBe('G');
    const bodies = buildSystem(home);
    const planet = findHome(bodies);
    expect(planet?.name).toBe('Venydes 5'); // pinned: the start hasn't changed since the first version
    expect(planet?.kind).toBe('planet');
    expect(planet && planet.kind !== 'star' && planet.type).toBe(WT.EarthLike);
    expect(bodies.some((b) => b.kind === 'moon' && b.parent === planet)).toBe(true);
  });

  it('builds physically sensible systems', () => {
    for (const sys of systemsNear(origin, JUMP_RANGE).slice(0, 20)) {
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
