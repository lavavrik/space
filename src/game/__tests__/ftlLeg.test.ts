import { describe, expect, it, vi } from 'vitest';
import { newShip, type Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot, ftlTransfer } from '../sim/autopilot';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { gatePoint, lagrangePoints } from '../sim/lagrange';
import type { Autopilot, CurrentSystem, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

// the drive's upkeep (exotic matter, the power bus) isn't what's tested here
vi.mock('../sim/ftl', async (orig) => ({
  ...(await orig<typeof import('../sim/ftl')>()),
  ftlUpkeep: () => true,
}));
// nor the thrusters' tanks and bus: thrust is just applied
vi.mock('../sim/resources', async (orig) => ({
  ...(await orig<typeof import('../sim/resources')>()),
  deltaVLeft: () => 1e6,
  applyThrust: () => {},
}));

/**
 * The autopilot's FTL leg to a Lagrange point, from `from` m behind it along its motion (the point
 * runs away from the ship at the planet's orbital speed, ~30–45 km/s in the star's frame). The
 * frame body is the star, as it is out there (the points lie outside the planet's SOI).
 */
function leg(k: 1 | 2 | 4, from: number, depart = false, hold = 0) {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  const ap: Autopilot = { body: w, type: 'lagrange', lk: k, revs: depart ? 3 : 0, station: null, r0: 1, period: 0, n: null, point: null, phase: 'transfer', settled: false, t0: 0, prop0: 0 };
  if (depart) ap.ph = { stage: 'depart', tArr: 0, checks: [], dvLeft: null, resume: 1, spent: 0, stall: 0 };
  const pt = () => (depart ? gatePoint(w, k as 4) : lagrangePoints(w)[k - 1]);
  const p0 = pt();
  const ship = newShip();
  ship.mode = 'ftl';
  ship.ap = ap;
  ship.pos.copy(p0.pos).addScaledVector(p0.vel.clone().sub(w.parent.vel).normalize(), -from);
  // nose on the point already, cruising
  ship.q.setFromRotationMatrix(new THREE.Matrix4().lookAt(ship.pos, p0.pos, new THREE.Vector3(0, 1, 0)));
  ship.ftlSpeed = 1e6;
  const g = { ship, cur, frameBody: w.parent, simTime: 0, fwd: new THREE.Vector3(), curSpeed: 0, warpFx: [], showMsg: () => {} } as unknown as Game;
  const dt = 1 / 60;
  let t = 0;
  for (; t < 300 && (ship.mode as string) !== 'normal'; t += dt) {
    g.simTime = t;
    updateBodies(bodies, t); // (the star frame: the ship isn't carried)
    ftlTransfer(g, dt);
  }
  const dropped = (ship.mode as string) === 'normal',
    offDrop = ship.pos.distanceTo(pt().pos);
  // then the hold flies the rest, as in the game's loop (sim/update.ts)
  const tDrop = t;
  // (the game's order: the clock and the bodies go to the step's end, then the ship is flown there)
  for (; dropped && t < tDrop + hold && !ap.settled; ) {
    t += dt;
    g.simTime = t;
    updateBodies(bodies, t);
    autopilot(g, dt, gravityAt(cur, ship.pos));
    ship.pos.addScaledVector(ship.vel, dt);
  }
  return { dropped, t: tDrop, offDrop, settled: ap.settled, tHold: t - tDrop, off: ship.pos.distanceTo(pt().pos) };
}

describe('the FTL leg to a moving point', () => {
  it('catches L1 and drops out beside it, though the point runs away at the planet\'s orbital speed', () => {
    const r = leg(1, 5e6);
    expect(r.dropped).toBe(true);
    expect(r.offDrop).toBeLessThan(31e3);
    expect(r.t).toBeLessThan(60);
  });

  it('catches L4 too, and a phasing transfer\'s departure gate', () => {
    for (const r of [leg(4, 5e6), leg(4, 5e6, true)]) {
      expect(r.dropped).toBe(true);
      expect(r.offDrop).toBeLessThan(31e3);
    }
  });

  it('then the hold closes the last 30 km and settles on the point', () => {
    for (const k of [1, 2, 4] as const) {
      const r = leg(k, 5e6, false, 1800);
      expect(r.settled).toBe(true);
      expect(r.off).toBeLessThan(100); // (where it really is: it used to settle a step's motion, ~0.5–0.9 km, ahead)
      expect(r.tHold).toBeLessThan(600);
    }
  });
});
