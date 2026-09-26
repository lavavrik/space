import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { THREE } from '../lib/three';
import { minOrbitAlt } from '../sim/orbits';
import { stationState } from '../sim/stations';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem, findHome } from '../universe/system';

const systems = systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 40);
const all = systems.flatMap((sys) => {
  const bodies = buildSystem(sys);
  return buildStations(sys, bodies).map((st) => ({ st, bodies }));
});

describe('stations', () => {
  it('orbit the home world', () => {
    const sys = homeSystem();
    const bodies = buildSystem(sys);
    expect(buildStations(sys, bodies).some((st) => st.parent === findHome(bodies))).toBe(true);
  });

  it('are the same on every visit', () => {
    const sys = systems[3];
    const a = buildStations(sys, buildSystem(sys)),
      b = buildStations(sys, buildSystem(sys));
    expect(a.map((s) => [s.name, s.a, s.e, s.pos.toArray()])).toEqual(b.map((s) => [s.name, s.a, s.e, s.pos.toArray()]));
  });

  it('orbit some worlds but not all', () => {
    const worlds = systems.flatMap((sys) => buildSystem(sys).filter((b) => b.kind !== 'star')).length;
    expect(all.length).toBeGreaterThan(worlds * 0.1);
    expect(all.length).toBeLessThan(worlds * 0.6);
  });

  it('are about the size of an Elite Dangerous station', () => {
    for (const { st } of all) {
      expect(st.size).toBeGreaterThanOrEqual(1000);
      expect(st.size).toBeLessThanOrEqual(1600);
    }
  });

  it('keep realistic orbits: near-circular, above the atmosphere, inside the SOI, below the moons, clear of rings', () => {
    for (const { st, bodies } of all) {
      const p = st.parent;
      expect(st.e).toBeLessThanOrEqual(0.02);
      expect(st.a * (1 - st.e)).toBeGreaterThanOrEqual(p.radius + minOrbitAlt(p));
      expect(st.a * (1 + st.e)).toBeLessThan(p.soi);
      for (const m of bodies) if (m.kind === 'moon' && m.parent === p) expect(st.a).toBeLessThan(m.orbit);
      if (p.ring) expect(st.a < p.radius * p.ring.inner || st.a > p.radius * p.ring.outer).toBe(true);
    }
  });

  it('follow Kepler orbits', () => {
    for (const { st } of all.slice(0, 30)) {
      const mu = st.parent.mu;
      const T = (2 * Math.PI) / st.n;
      for (const t of [0, 1234.5, T * 0.37]) {
        stationState(st, t);
        const r = st.pos.distanceTo(st.parent.pos);
        expect(r).toBeGreaterThanOrEqual(st.a * (1 - st.e) * (1 - 1e-9));
        expect(r).toBeLessThanOrEqual(st.a * (1 + st.e) * (1 + 1e-9));
        // vis-viva: v² = μ(2/r − 1/a)
        expect(st.vel.lengthSq() / (mu * (2 / r - 1 / st.a))).toBeCloseTo(1, 9);
        const p0 = st.pos.clone();
        stationState(st, t + T);
        expect(st.pos.distanceTo(p0) / st.a).toBeLessThan(1e-6);
      }
    }
  });
});
