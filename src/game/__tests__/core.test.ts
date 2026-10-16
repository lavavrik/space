import { describe, expect, it } from 'vitest';
import { ARRIVE_FLUX, AU, CORE_MASS, MSUN, SECTOR_SIZE, fluxDist } from '../constants';
import { THREE } from '../lib/three';
import { generateSector, homeSystem, systemById, systemsNear } from '../universe/galaxy';
import { CORE_ID, CORE_POS, CORE_SECTOR, coreSystem } from '../universe/core';
import { buildStations } from '../universe/stations';
import { buildSystem } from '../universe/system';

describe('galactic core', () => {
  const core = coreSystem();

  it('sits 1,000 ly out, as index 0 of its sector', () => {
    expect(core.pos.distanceTo(new THREE.Vector3())).toBeCloseTo(1000, 6);
    expect(CORE_SECTOR).toEqual([97, -5, 24]);
    expect(CORE_ID).toBe('97,-5,24:0');
    expect(generateSector(...CORE_SECTOR)[0]).toBe(core);
    for (const [x, i] of CORE_POS.toArray().map((x, k) => [x, CORE_SECTOR[k]])) expect(Math.abs(x - i * SECTOR_SIZE)).toBeLessThanOrEqual(SECTOR_SIZE / 2);
  });

  it('is found by id and by position, once', () => {
    expect(systemById(CORE_ID)).toBe(core);
    expect(systemsNear(CORE_POS, 30).filter((s) => s.id === CORE_ID)).toEqual([core]);
    expect(homeSystem().name).toBe('Venydes');
  });

  it('leaves the rest of its sector as it was', () => {
    // (the core only takes index 0's place: the other systems' positions and seeds are unchanged)
    const rest = generateSector(...CORE_SECTOR).slice(1);
    for (const [k, s] of rest.entries()) expect(s.id).toBe(`${CORE_SECTOR.join(',')}:${k + 1}`);
  });

  it('is a lone 1e8 M☉ black hole with no planets or stations', () => {
    const bodies = buildSystem(core);
    expect(bodies).toHaveLength(1);
    const h = bodies[0];
    expect(h.kind).toBe('star');
    if (h.kind !== 'star') return;
    expect(h.hole).toBeTruthy();
    expect(h.mass).toBeCloseTo(CORE_MASS * MSUN, -30);
    expect(h.radius / AU).toBeCloseTo(1.97, 2); // 2GM/c²
    expect(h.hole!.diskIn).toBeCloseTo(3 * h.radius, -3);
    expect(buildStations(core, bodies)).toEqual([]);
  });

  it('drops you 150 AU out', () => {
    const h = buildSystem(core)[0];
    if (h.kind !== 'star') throw new Error('not a star');
    expect(fluxDist(h.L, ARRIVE_FLUX, h.radius) / AU).toBeCloseTo(150, 1);
  });
});
