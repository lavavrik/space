import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { keplerState, orbitThrough, updateBodies } from '../sim/kepler';
import { THREE } from '../lib/three';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, findHome } from '../universe/system';
import type { World } from '../types';

const systems = systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 30);
const worldsOf = (bodies: ReturnType<typeof buildSystem>) => bodies.filter((b): b is World => b.kind !== 'star');

describe('orbits', () => {
  it('orbitThrough passes through its start point, on the orbit it describes', () => {
    const rel = new THREE.Vector3(3e10, 1e8, -4e10),
      mu = 1.3e20;
    for (const [e, nu0] of [[0, 0], [0.05, 1], [0.3, 4], [0.6, 2.5]]) {
      const o = orbitThrough(rel, mu, e, nu0);
      const pos = new THREE.Vector3(),
        vel = new THREE.Vector3();
      keplerState(o, 0, new THREE.Vector3(), new THREE.Vector3(), pos, vel);
      expect(pos.distanceTo(rel) / rel.length()).toBeLessThan(1e-9);
      expect(vel.lengthSq() / (mu * (2 / pos.length() - 1 / o.a))).toBeCloseTo(1, 9);
      // prograde: counter-clockwise seen from +y
      expect(new THREE.Vector3().crossVectors(pos, vel).y).toBeGreaterThan(0);
    }
  });

  it('keeps generated systems where they were at t = 0', () => {
    // the home world is where the game has always started
    const bodies = buildSystem(homeSystem());
    const home = findHome(bodies)!;
    const p0 = home.pos.clone();
    updateBodies(bodies, 3600);
    expect(home.pos.distanceTo(p0)).toBeGreaterThan(1e6); // it moved…
    updateBodies(bodies, 0);
    expect(home.pos.distanceTo(p0)).toBeLessThan(1); // …and time 0 is the generated layout
  });

  it('moves worlds on realistic, near-circular, non-crossing orbits', () => {
    for (const sys of systems) {
      const bodies = buildSystem(sys);
      const worlds = worldsOf(bodies);
      const planets = worlds.filter((w) => w.kind === 'planet');
      for (const w of worlds) {
        expect(w.orb.e).toBeLessThanOrEqual(w.kind === 'planet' ? 0.06 : 0.03);
        const T = (2 * Math.PI) / w.orb.n;
        expect(T).toBeGreaterThan(3600); // nothing whips round in under an hour
        if (w.kind === 'moon') {
          // moons stay well clear of their planet and inside its sphere of influence
          expect(w.orb.a * (1 - w.orb.e)).toBeGreaterThan(w.parent.radius * 2);
          expect(w.orb.a * (1 + w.orb.e)).toBeLessThan(w.parent.soi);
        }
      }
      // (each star's own, in a wide pair)
      for (let i = 1; i < planets.length; i++) {
        if (planets[i].parent !== planets[i - 1].parent) continue;
        const [inner, outer] = [planets[i - 1].orb, planets[i].orb];
        expect(inner.a * (1 + inner.e)).toBeLessThan(outer.a * (1 - outer.e));
      }
    }
  });

  it('keeps moons with their planets as everything moves', () => {
    const bodies = buildSystem(systems[5]);
    for (const t of [0, 86400, 3.1e7]) {
      updateBodies(bodies, t);
      for (const m of worldsOf(bodies)) {
        if (m.kind !== 'moon') continue;
        const d = m.pos.distanceTo(m.parent.pos);
        expect(d).toBeGreaterThanOrEqual(m.orb.a * (1 - m.orb.e) * (1 - 1e-9));
        expect(d).toBeLessThanOrEqual(m.orb.a * (1 + m.orb.e) * (1 + 1e-9));
      }
    }
  });
});
