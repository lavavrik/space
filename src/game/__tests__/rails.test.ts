import { describe, expect, it } from 'vitest';
import { newShip, type Game } from '../Game';
import { THREE } from '../lib/three';
import { perturbation } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { railsStep } from '../sim/timewarp';
import type { Body, CurrentSystem, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

function scene() {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  return { bodies, w, cur };
}

describe('time warp\'s rails and the third bodies', () => {
  it('takes the other bodies where they were at each substep, not where the frame left them', () => {
    const { bodies, w, cur } = scene();
    const T = 5e6,
      lag = -1600;
    // in the star's frame, near L1 (the planet's pull), and in the planet's, at 0.9 SOI (the star's tide)
    const cases: [Body, () => THREE.Vector3][] = [
      [w.parent, () => lagrangePoints(w)[0].pos.clone().sub(w.parent.pos)],
      [w, () => new THREE.Vector3(0.9 * w.soi, 0, 0)],
    ];
    for (const [fb, relOf] of cases) {
      updateBodies(bodies, T + lag);
      const rel = relOf();
      const want = perturbation(cur, fb, fb.pos.clone().add(rel), new THREE.Vector3());
      updateBodies(bodies, T);
      const got = perturbation(cur, fb, fb.pos.clone().add(rel), new THREE.Vector3(), lag);
      const frozen = perturbation(cur, fb, fb.pos.clone().add(rel), new THREE.Vector3());
      expect(got.distanceTo(want)).toBeLessThan(0.01 * frozen.distanceTo(want));
    }
  });

  it('keeps a ship drifting at L1 or L2 on its point under ×100,000 as at ×100', () => {
    for (const k of [1, 2] as const) {
      const off = [100, 100000].map((warp) => {
        const { bodies, w, cur } = scene();
        const lp = lagrangePoints(w)[k - 1];
        const ship = newShip();
        ship.pos.copy(lp.pos);
        ship.vel.copy(lp.vel).sub(w.parent.vel);
        const g = { ship, cur, frameBody: w.parent, warp, simTime: 0, showMsg: () => {} } as unknown as Game;
        const dt = warp / 60;
        for (let t = 0; t < 10 * 86400; t += dt) {
          updateBodies(bodies, t + dt); // (advanceBodies: the star frame, so the ship isn't carried)
          railsStep(g, dt);
        }
        return ship.pos.distanceTo(lagrangePoints(w)[k - 1].pos);
      });
      expect(off[1]).toBeLessThan(2e3); // (frozen bodies: ~600 km)
    }
  });
});
