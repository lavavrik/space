import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { COLLINEAR_GROWTH, driftTime, lagrangePoints } from '../sim/lagrange';
import { saddleModes } from '../sim/manifold';
import type { CurrentSystem, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

function circular() {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  w.orb.e = 0;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  return { bodies, w, cur };
}

/** Fly a ship started `off` (system axes) from the point with the saddle's velocity `vel`, returning its distance from the point at each of `times`. */
function fly(k: 1 | 2, off: THREE.Vector3, vel: THREE.Vector3, times: number[]) {
  const { bodies, w, cur } = circular();
  const lp = lagrangePoints(w)[k - 1];
  const pos = lp.pos.clone().add(off),
    v = lp.vel.clone().add(vel);
  const dt = 900;
  const out: number[] = [];
  let t = 0;
  for (const T of times) {
    while (t < T) {
      v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
      pos.addScaledVector(v, dt);
      t += dt;
      updateBodies(bodies, t);
      v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
    }
    out.push(pos.distanceTo(lagrangePoints(w)[k - 1].pos));
  }
  return out;
}

describe('the saddle at L1 and L2', () => {
  it('has the small-mass growth rate (2.53 n: 23 days at Earth) for a light planet, and follows the planet\'s mass', () => {
    const { w } = circular();
    for (const k of [1, 2] as const) {
      const m = saddleModes(w, k);
      expect(m.lambda / w.orb.n).toBeGreaterThan(COLLINEAR_GROWTH * 0.9);
      expect(m.lambda / w.orb.n).toBeLessThan(COLLINEAR_GROWTH * 1.1);
      expect(m.nu).toBeGreaterThan(0);
      expect(m.unstable.length()).toBeCloseTo(1, 9);
      // the unstable and stable directions are different lines
      expect(Math.abs(m.unstable.dot(m.stable))).toBeLessThan(0.999);
    }
  });

  it('predicts the drift: a ship nudged along the unstable direction leaves at e^(λt), along the stable one it does not', () => {
    const { w } = circular();
    const hill = w.parent.pos.distanceTo(w.pos) * Math.cbrt(w.mu / (3 * w.parent.mu));
    for (const k of [1, 2] as const) {
      const m = saddleModes(w, k);
      const d0 = 1e-4 * hill;
      const days = [8, 16].map((d) => d * 86400);
      // started on the unstable manifold with its own velocity: it grows at e^(λt), no more
      const grow = fly(k, m.unstable.clone().multiplyScalar(d0), m.unstable.clone().multiplyScalar(d0 * m.lambda), days);
      const rate = Math.log(grow[1] / grow[0]) / (days[1] - days[0]);
      expect(rate / m.lambda).toBeGreaterThan(0.85);
      expect(rate / m.lambda).toBeLessThan(1.15);
      // started on the stable manifold it falls in toward the point first
      const shrink = fly(k, m.stable.clone().multiplyScalar(d0), m.stable.clone().multiplyScalar(-d0 * m.lambda), [14 * 86400]);
      expect(shrink[0]).toBeLessThan(d0 * 0.7); // (~1.0 e-folds in 14 days at this λ: e^-0.6 ≈ 0.55)
    }
  });

  it('sets the drift time shown for the point', () => {
    const { w } = circular();
    const [l1, l2] = lagrangePoints(w);
    expect(driftTime(l1)).toBeCloseTo(1 / saddleModes(w, 1).lambda, 3);
    expect(driftTime(l2)).toBeCloseTo(1 / saddleModes(w, 2).lambda, 3);
    expect(driftTime(lagrangePoints(w)[3])).toBe(Infinity);
  });
});
