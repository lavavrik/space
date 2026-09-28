import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { HOME_ID, homeSystem, systemById, systemsNear } from '../universe/galaxy';
import { ago } from '../save';

describe('save', () => {
  it('finds every nearby system again by its id', () => {
    const near = systemsNear(new THREE.Vector3(), 40);
    expect(near.length).toBeGreaterThan(10);
    for (const s of near) expect(systemById(s.id)).toMatchObject({ id: s.id, seed: s.seed, name: s.name });
    expect(systemById(HOME_ID)).toBe(homeSystem());
  });

  it('rejects ids that name no system', () => {
    expect(systemById('nonsense')).toBeNull();
    expect(systemById('0,0,0:99')).toBeNull();
  });

  it('says how long ago', () => {
    const now = 1e12;
    expect(ago(now - 12e3, now)).toBe('12 s ago');
    expect(ago(now - 5 * 60e3, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3600e3, now)).toBe('3 h ago');
    expect(ago(now - 86400e3, now)).toBe('1 day ago');
  });
});
