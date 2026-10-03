import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { THREE } from '../lib/three';
import { updateBodies } from '../sim/kepler';
import { ROUTH_RATIO, YEAR, driftTime, hillRatio, lagrangePoints, trojansStable } from '../sim/lagrange';
import type { World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, findHome } from '../universe/system';

function home() {
  const bodies = buildSystem(homeSystem());
  updateBodies(bodies, 12345);
  return findHome(bodies) as World;
}
const rel = (p: THREE.Vector3, w: World) => p.clone().sub(w.parent.pos);

describe('lagrange points', () => {
  it('put L4 and L5 at the corners of an equilateral triangle with the planet and its parent', () => {
    const w = home();
    const [, , , l4, l5] = lagrangePoints(w);
    const r = w.pos.distanceTo(w.parent.pos);
    for (const p of [l4, l5]) {
      expect(p.pos.distanceTo(w.parent.pos) / r).toBeCloseTo(1, 9);
      expect(p.pos.distanceTo(w.pos) / r).toBeCloseTo(1, 9);
    }
    // L4 leads the planet, L5 trails it
    const dir = w.vel.clone().sub(w.parent.vel).normalize();
    expect(l4.pos.clone().sub(w.pos).dot(dir)).toBeGreaterThan(0);
    expect(l5.pos.clone().sub(w.pos).dot(dir)).toBeLessThan(0);
  });

  it('put L1 and L2 on the star–planet line, a Hill radius either side, and L3 opposite', () => {
    const w = home();
    const [l1, l2, l3] = lagrangePoints(w);
    const r = rel(w.pos, w);
    const u = r.clone().normalize();
    const rho = hillRatio(w.mu / w.parent.mu);
    expect(rel(l1.pos, w).dot(u) / r.length()).toBeCloseTo(1 - rho, 9);
    expect(rel(l2.pos, w).dot(u) / r.length()).toBeCloseTo(1 + rho, 9);
    expect(rel(l3.pos, w).dot(u)).toBeLessThan(-r.length());
    for (const p of [l1, l2, l3]) expect(rel(p.pos, w).clone().cross(u).length() / r.length()).toBeLessThan(1e-9);
  });

  it('carry every point round the parent at the planet\'s own angular rate', () => {
    const w = home();
    const r = rel(w.pos, w);
    const n = r.clone().cross(w.vel.clone().sub(w.parent.vel)).length() / r.lengthSq();
    for (const p of lagrangePoints(w)) {
      const rp = rel(p.pos, w);
      const vp = p.vel.clone().sub(w.parent.vel);
      expect(rp.clone().cross(vp).length() / rp.lengthSq() / n).toBeCloseTo(1, 9);
    }
  });

  it('stay with the planet as it moves: the angle to L4 holds', () => {
    const bodies = buildSystem(homeSystem());
    const w = findHome(bodies) as World;
    const angle = () => {
      const l4 = lagrangePoints(w)[3];
      return rel(l4.pos, w).angleTo(rel(w.pos, w));
    };
    updateBodies(bodies, 0);
    const a0 = angle();
    updateBodies(bodies, 0.37 * YEAR);
    expect(angle()).toBeCloseTo(a0, 9);
    expect(a0).toBeCloseTo(Math.PI / 3, 9);
  });

  it('are stable only at L4 and L5, and only above the Routh mass ratio', () => {
    for (const p of lagrangePoints(home())) expect(p.stable).toBe(p.k >= 4);
    expect(trojansStable(1 / (ROUTH_RATIO + 1))).toBe(true);
    expect(trojansStable(1 / (ROUTH_RATIO - 1))).toBe(false);
  });

  it('cost Earth-like station-keeping, a few m/s a year, only at the unstable points', () => {
    const w = home();
    for (const p of lagrangePoints(w)) {
      if (p.stable) expect(p.dvYear).toBe(0);
      else expect(p.dvYear).toBeGreaterThan(0);
    }
    const [l1] = lagrangePoints(w);
    // Sun–Earth-like orbit and mass ratio → around 3 m/s a year (JWST's order); scale with the planet's year
    const yearsPerOrbit = (2 * Math.PI) / w.orb.n / YEAR;
    if (w.mu / w.parent.mu > 1e-6 && w.mu / w.parent.mu < 1e-5 && yearsPerOrbit > 0.5 && yearsPerOrbit < 2) {
      expect(l1.dvYear).toBeGreaterThan(1);
      expect(l1.dvYear).toBeLessThan(10);
    }
    expect(driftTime(l1)).toBeGreaterThan(0);
    expect(driftTime(lagrangePoints(w)[3])).toBe(Infinity);
  });

  it('work for every planet in nearby systems without producing NaNs', () => {
    for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 25)) {
      const bodies = buildSystem(sys);
      updateBodies(bodies, 777);
      for (const b of bodies) {
        if (b.kind !== 'planet') continue;
        for (const p of lagrangePoints(b)) {
          expect(p.pos.toArray().every(Number.isFinite)).toBe(true);
          expect(p.vel.toArray().every(Number.isFinite)).toBe(true);
          expect(Number.isFinite(p.dvYear)).toBe(true);
        }
      }
    }
  });
});
