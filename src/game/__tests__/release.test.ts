import { describe, expect, it, vi } from 'vitest';
import { THREE } from '../lib/three';
import type { Game } from '../Game';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { hillRadius } from '../sim/gravity';
import { RELEASE_DV, canRelease, releaseFromPoint, releasePlan } from '../sim/release';
import type { CurrentSystem, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

vi.mock('../sim/resources', () => ({ applyThrust: () => {}, deltaVLeft: () => 1e4 }));

function circular() {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  w.orb.e = 0;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  return { bodies, w, cur };
}

describe('release from L1 and L2', () => {
  for (const k of [1, 2] as const) {
    it(`L${k}: the push picks the branch, and the drift opens as predicted`, () => {
      const res: Record<string, { toward: number; hillAt: number }> = {};
      for (const branch of ['planet', 'away'] as const) {
        const { bodies, w, cur } = circular();
        const plan = releasePlan(w, k, branch);
        const lp = lagrangePoints(w)[k - 1];
        const pos = lp.pos.clone(),
          v = lp.vel.clone().addScaledVector(plan.dir, RELEASE_DV);
        const hill = hillRadius(w);
        const d0 = pos.distanceTo(w.pos);
        const dt = 900;
        let t = 0,
          hillAt = Infinity;
        while (t < plan.tHill * 2.5 && hillAt === Infinity) {
          v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
          pos.addScaledVector(v, dt);
          t += dt;
          updateBodies(bodies, t);
          v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
          if (pos.distanceTo(lagrangePoints(w)[k - 1].pos) > hill * 0.3) hillAt = t;
        }
        res[branch] = { toward: pos.distanceTo(w.pos) - d0, hillAt };
        // (the predicted time to a Hill radius, less the last e-fold or so to 0.3 of one)
        expect(hillAt).toBeLessThan(plan.tHill);
        expect(hillAt).toBeGreaterThan(plan.tHill * 0.6);
      }
      expect(res.planet.toward).toBeLessThan(res.away.toward); // (one side closes on the planet, the other opens)
    });
  }

  it('the two branches point opposite ways along the unstable direction', () => {
    const { w } = circular();
    const a = releasePlan(w, 2, 'planet').dir,
      b = releasePlan(w, 2, 'away').dir;
    expect(a.dot(b)).toBeCloseTo(-1, 9);
    expect(a.dot(new THREE.Vector3().subVectors(w.pos, lagrangePoints(w)[1].pos))).toBeGreaterThan(0);
  });

  it('works only from a settled L1 or L2 hold; then pushes the ship and lets go', () => {
    const { w } = circular();
    const msgs: string[] = [];
    const ship = { vel: new THREE.Vector3(), ap: { type: 'lagrange', lk: 2, body: w, settled: false, ph: undefined } as unknown };
    const g = { ship, frameBody: w.parent, apPanel: true, showMsg: (m: string) => msgs.push(m), invalidateHud: () => {} } as unknown as Game;
    expect(canRelease(g).ok).toBe(false);
    releaseFromPoint(g, 'away');
    expect(ship.vel.length()).toBe(0);
    (ship.ap as { settled: boolean }).settled = true;
    expect(canRelease(g).ok).toBe(true);
    releaseFromPoint(g, 'away');
    expect(ship.vel.length()).toBeCloseTo(RELEASE_DV, 9);
    expect(ship.ap).toBeNull();
    expect(msgs[msgs.length - 1]).toMatch(/Released/);
    (ship as { ap: unknown }).ap = { type: 'lagrange', lk: 4, body: w, settled: true };
    expect(canRelease(g).ok).toBe(false);
  });
});
