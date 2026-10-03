import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { THREE } from '../lib/three';
import { gravityAt, hillRadius, perturbation } from '../sim/gravity';
import { keplerState, updateBodies } from '../sim/kepler';
import { ROUTH_RATIO, YEAR, driftTime, hillRatio, lagrangePoints, trojansStable } from '../sim/lagrange';
import { saddleModes } from '../sim/manifold';
import type { CurrentSystem, Star, World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

function curOf(bodies: ReturnType<typeof buildSystem>): CurrentSystem {
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  return { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
}

/** The home system with its world on a circular orbit, so a rotating frame is exact. */
function circular() {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  w.orb.e = 0;
  updateBodies(bodies, 0);
  return { bodies, w, cur: curOf(bodies) };
}

function home() {
  const bodies = buildSystem(homeSystem());
  updateBodies(bodies, 12345);
  return findHome(bodies) as World;
}
const rel = (p: THREE.Vector3, w: World) => p.clone().sub(w.parent.pos);

describe('lagrange points', () => {
  it('put L4 and L5 at the corners of an equilateral triangle with the planet and its parent', () => {
    const { w } = circular();
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
    const { w } = circular(); // (an eccentric orbit moves them: its angular rate isn't steady)
    const [l1, l2, l3] = lagrangePoints(w);
    const r = rel(w.pos, w);
    const u = r.clone().normalize();
    const rho = hillRatio(w.mu / w.parent.mu);
    // (solved against the sim's own force, so within a few percent of the Hill-radius estimate)
    expect(Math.abs(rel(l1.pos, w).dot(u) / r.length() - (1 - rho)) / rho).toBeLessThan(0.05);
    expect(Math.abs(rel(l2.pos, w).dot(u) / r.length() - (1 + rho)) / rho).toBeLessThan(0.05);
    expect(rel(l3.pos, w).dot(u) / r.length()).toBeCloseTo(-1, 9);
    for (const p of [l1, l2, l3]) expect(rel(p.pos, w).clone().cross(u).length() / r.length()).toBeLessThan(1e-9);
  });

  it('carry every point round the parent at the planet\'s own angular rate', () => {
    const { w } = circular();
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
    w.orb.e = 0;
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

  it('put L3, L4 and L5 on the planet\'s own orbit, a fixed time ahead or behind it, even when it is eccentric', () => {
    const bodies = buildSystem(homeSystem());
    const w = findHome(bodies) as World;
    w.orb.e = 0.05;
    for (const t of [0, 0.3 * YEAR, 0.71 * YEAR]) {
      updateBodies(bodies, t);
      for (const k of [3, 4, 5] as const) {
        const shift = { 3: Math.PI, 4: Math.PI / 3, 5: -Math.PI / 3 }[k] / w.orb.n; // seconds along the orbit
        const pos = new THREE.Vector3(),
          vel = new THREE.Vector3();
        keplerState(w.orb, t + shift, w.parent.pos, w.parent.vel, pos, vel);
        const p = lagrangePoints(w)[k - 1];
        expect(p.pos.distanceTo(pos) / w.pos.distanceTo(w.parent.pos)).toBeLessThan(1e-9);
        expect(p.vel.distanceTo(vel)).toBeLessThan(1e-3);
      }
    }
  });

  it('are equilibria of the force a ship feels: the net pull equals the centripetal pull', () => {
    const { w, cur } = circular();
    const r = w.pos.distanceTo(w.parent.pos);
    for (const p of lagrangePoints(w)) {
      const g = gravityAt(cur, p.pos);
      expect(g.body).toBe(w.parent); // (outside the planet's sphere of influence, in the star's frame)
      expect(g.vec.distanceTo(p.acc) / p.acc.length()).toBeLessThan(1e-6);
      // …and the planet's pull really is part of it where it matters, at L1 and L2
      const bare = p.pos.clone().sub(w.parent.pos).multiplyScalar(-w.parent.mu / p.pos.distanceTo(w.parent.pos) ** 3);
      const miss = bare.distanceTo(p.acc) / p.acc.length();
      if (p.k <= 2) expect(miss).toBeGreaterThan(0.01);
      else expect(miss).toBeLessThan(1e-3);
    }
    expect(r).toBeGreaterThan(0);
  });

  it('leave a ship at the point with no thrust: it keeps pace with L4 for two years, and with L1 for days', () => {
    for (const [k, days, tol] of [[4, 730, 1e-3], [1, 6, 1e-3]] as const) {
      const { bodies, w, cur } = circular();
      const lp = lagrangePoints(w)[k - 1];
      const pos = lp.pos.clone(),
        vel = lp.vel.clone();
      const dt = 1800;
      const a = new THREE.Vector3();
      let worst = 0;
      for (let t = 0; t < days * 86400; t += dt) {
        // kick–drift–kick, with the planet moved to the middle of the step
        a.copy(gravityAt(cur, pos).vec);
        vel.addScaledVector(a, dt / 2);
        pos.addScaledVector(vel, dt);
        updateBodies(bodies, t + dt);
        a.copy(gravityAt(cur, pos).vec);
        vel.addScaledVector(a, dt / 2);
        const here = lagrangePoints(w)[k - 1].pos;
        worst = Math.max(worst, pos.distanceTo(here) / w.pos.distanceTo(w.parent.pos));
      }
      expect(worst).toBeLessThan(tol);
    }
  });

  it('drive a ship that starts a little off L1 away, as an unstable point should', () => {
    const { bodies, w, cur } = circular();
    const lp = lagrangePoints(w)[0];
    const hill = hillRadius(w);
    const pos = lp.pos.clone().addScaledVector(lp.pos.clone().sub(w.parent.pos).normalize(), 1e-4 * hill);
    const vel = lp.vel.clone();
    const dt = 1800;
    const grow = (1.5 * Math.log(1e3)) / saddleModes(w, 1).lambda; // (a few e-folds of this planet's saddle)
    for (let t = 0; t < grow; t += dt) {
      vel.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
      pos.addScaledVector(vel, dt);
      updateBodies(bodies, t + dt);
      vel.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
    }
    expect(pos.distanceTo(lagrangePoints(w)[0].pos)).toBeGreaterThan(0.1 * hill); // grown by e^(1.5 × ln 1000), ~30000× the start
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

  it('add no thrust inside a planet\'s sphere of influence orbit, and join the pulls smoothly at its edge', () => {
    const { w, cur } = circular();
    const v = new THREE.Vector3();
    // deep in the SOI: no perturbation at all
    expect(perturbation(cur, w, w.pos.clone().add(new THREE.Vector3(w.soi * 0.3, 0, 0)), v).length()).toBe(0);
    // at the SOI's edge the same acceleration is felt from either side
    const out = w.pos.clone().add(new THREE.Vector3(1, 0, 0).setLength(w.soi * 1.0001));
    const inn = w.pos.clone().add(new THREE.Vector3(1, 0, 0).setLength(w.soi * 0.9999));
    const aOut = gravityAt(cur, out); // star frame
    const aIn = gravityAt(cur, inn); // planet frame
    expect(aOut.body).toBe(w.parent);
    expect(aIn.body).toBe(w);
    // inertial acceleration = the frame body's own + the pull relative to it
    const frameAcc = w.pos.clone().sub(w.parent.pos).multiplyScalar(-w.parent.mu / w.pos.distanceTo(w.parent.pos) ** 3);
    const inertial = aIn.vec.clone().add(frameAcc);
    expect(inertial.distanceTo(aOut.vec) / aOut.vec.length()).toBeLessThan(2e-3);
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
