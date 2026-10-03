import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { keplerAt, keplerState, updateBodies } from '../sim/kepler';
import { YEAR, gatePoint } from '../sim/lagrange';
import { correction, planPhasing, propagate } from '../sim/phasing';
import type { World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome } from '../universe/system';

function world(e: number) {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  w.orb.e = e;
  updateBodies(bodies, 0);
  return { bodies, w };
}

describe('Kepler propagation', () => {
  it('follows an eccentric orbit exactly, over many orbits', () => {
    const { w } = world(0.05);
    const o = w.orb;
    const r0 = new THREE.Vector3(),
      v0 = new THREE.Vector3();
    keplerAt(o, 1.234, r0, v0);
    const r = new THREE.Vector3(),
      v = new THREE.Vector3();
    for (const years of [0.1, 0.77, 3.3, 12.9]) {
      const dt = years * YEAR;
      propagate(r0, v0, w.parent.mu, dt, r, v);
      const want = new THREE.Vector3(),
        wantV = new THREE.Vector3();
      keplerAt(o, 1.234 + o.n * dt, want, wantV);
      // (the home orbit's n isn't exactly sqrt(mu/a³) to the last digit, so allow a sliver)
      expect(r.distanceTo(want) / o.a).toBeLessThan(2e-5 * Math.max(1, years));
    }
  });
});

describe('phasing transfers', () => {
  /** The ship's state at the departure gate, where a phasing transfer starts from. */
  function fromGate(w: World, k: 3 | 4 | 5) {
    const g = gatePoint(w, k);
    return { r0: g.pos.clone().sub(w.parent.pos), v0: g.vel.clone().sub(w.parent.vel) };
  }

  for (const k of [4, 5, 3] as const) {
    it(`reaches L${k}: the plan's orbit ends on the point, near its velocity`, () => {
      const { w } = world(0.02);
      const { r0, v0 } = fromGate(w, k);
      const plan = planPhasing(w, k, r0, v0, 0, 3);
      expect(plan.ok).toBe(true);
      expect(plan.miss).toBeLessThan(5e3);
      // fly the burn out and see where it ends up, against the point at that time
      const end = propagate(r0, plan.v1, w.parent.mu, plan.T);
      const bodies = [w];
      void bodies;
      const want = lagrangePointAt(w, k, plan.T);
      expect(end.r.distanceTo(want)).toBeLessThan(5e3);
      expect(plan.dv2).toBeLessThan(5e3); // what's left to match is a few km/s at worst
      expect(plan.dv1.length()).toBeLessThan(3000);
    });
  }

  it('costs less the longer it takes: about 1 / N', () => {
    const { w } = world(0);
    const { r0, v0 } = fromGate(w, 4);
    const cost = (N: number) => {
      const p = planPhasing(w, 4, r0, v0, 0, N);
      return p.dv1.length() + p.dv2;
    };
    const [c1, c3, c6, c12] = [cost(1), cost(3), cost(6), cost(12)];
    expect(c3).toBeLessThan(c1 * 0.5);
    expect(c6).toBeLessThan(c3 * 0.65);
    expect(c12).toBeLessThan(c6 * 0.65);
    // about 30° to cover over three orbits: about v/9N of the planet's orbital speed, in all
    const v = v0.length();
    expect(c3).toBeLessThan((v / (9 * 3)) * 3);
    expect(c3).toBeGreaterThan(v / (9 * 3) / 3);
  });

  it('corrects a drifted path with a small burn', () => {
    const { w } = world(0.02);
    const { r0, v0 } = fromGate(w, 4);
    const plan = planPhasing(w, 4, r0, v0, 0, 3);
    // coast a third of the way, nudged off by 6 m/s, then correct
    const half = plan.T / 3;
    const mid = propagate(r0, plan.v1.clone().add(new THREE.Vector3(5, -3, 2)), w.parent.mu, half);
    const target = lagrangePointAt(w, 4, plan.T);
    const fix = correction(mid.r, mid.v, w.parent.mu, plan.T - half, target);
    expect(fix.miss).toBeLessThan(5e3);
    expect(fix.dv.length()).toBeLessThan(15);
    expect(fix.dv.length()).toBeGreaterThan(1);
  });
});

/** The point's place (relative to the parent) `T` s after sim time 0. */
function lagrangePointAt(w: World, k: 3 | 4 | 5, T: number) {
  const pos = new THREE.Vector3(),
    vel = new THREE.Vector3();
  const shift = { 3: Math.PI, 4: Math.PI / 3, 5: -Math.PI / 3 }[k];
  keplerState(w.orb, T + shift / w.orb.n, new THREE.Vector3(), new THREE.Vector3(), pos, vel);
  return pos;
}
