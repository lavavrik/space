import { describe, expect, it } from 'vitest';
import { defaultAvionics, NAV_COMPUTERS, ORBIT_COMPUTERS, SCANNERS } from '../avionics/catalog';

describe('avionics catalogue', () => {
  const all = [...ORBIT_COMPUTERS, ...SCANNERS, ...NAV_COMPUTERS];

  it('gives every unit a unique id and model', () => {
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.model)).size).toBe(all.length);
  });

  it('fits the default ship with the best unit of each kind', () => {
    const a = defaultAvionics();
    expect(a.orbit?.model).toBe('HX-9100');
    expect(a.scanner?.model).toBe('AS-1200');
    expect(a.nav?.model).toBe('MNV-7000');
  });

  it('orders each line-up from basic to best', () => {
    for (let i = 1; i < ORBIT_COMPUTERS.length; i++) {
      expect(ORBIT_COMPUTERS[i].caps.types.length).toBeGreaterThanOrEqual(ORBIT_COMPUTERS[i - 1].caps.types.length);
      expect(ORBIT_COMPUTERS[i].caps.profile.acc).toBeGreaterThan(ORBIT_COMPUTERS[i - 1].caps.profile.acc);
    }
    for (let i = 1; i < SCANNERS.length; i++) expect(SCANNERS[i].caps.resolution).toBeLessThan(SCANNERS[i - 1].caps.resolution);
    for (let i = 1; i < NAV_COMPUTERS.length; i++) expect(NAV_COMPUTERS[i].caps.maxHops).toBeGreaterThan(NAV_COMPUTERS[i - 1].caps.maxHops);
  });
});
