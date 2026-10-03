import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot } from '../sim/autopilot';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import type { Autopilot, CurrentSystem, Ship, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

// the thruster model needs a power bus and tanks; here thrust is just applied and its Δv summed
let spent = 0;
vi.mock('../sim/resources', async (orig) => ({
  ...(await orig<typeof import('../sim/resources')>()),
  applyThrust: (_g: unknown, T: THREE.Vector3) => {
    spent += T.length();
  },
}));

function setup(k: 1 | 2 | 3 | 4 | 5, circular = true) {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  if (circular) w.orb.e = 0;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  const lp = lagrangePoints(w)[k - 1];
  const ap: Autopilot = { body: w, type: 'lagrange', lk: k, station: null, r0: lp.pos.distanceTo(w.pos), period: 0, n: null, point: null, phase: 'insert', settled: false, t0: 0, prop0: 0 };
  // start 200 km off the point, at rest relative to the planet (as an FTL drop leaves it)
  const ship = {
    pos: lp.pos.clone().add(new THREE.Vector3(2e5, 0, 0)),
    vel: w.vel.clone().sub(w.parent.vel),
    ap,
    mode: 'normal',
    ftlCharge: 0,
    avionics: { orbit: null },
  } as unknown as Ship;
  const g = { ship, frameBody: w.parent, cur, simTime: 0, showMsg: () => {} } as unknown as Game;
  return { bodies, w, cur, ship, ap, g };
}

/**
 * Fly the autopilot for `secs` at the game's own kind of step (its loop is tuned for ~16 ms frames:
 * at a few seconds a step it limit-cycles), stepping the planet along. Returns where it ends and
 * what it burned over the last hour, once it has long settled, in m/s a year.
 */
function fly(k: 1 | 2 | 3 | 4 | 5, secs: number, dt = 0.05) {
  const { bodies, w, cur, ship, ap, g } = setup(k);
  spent = 0;
  let settledAt = -1,
    spentBefore = 0;
  for (let t = 0; t < secs; t += dt) {
    if (t >= secs - 3600 && spentBefore === 0) spentBefore = spent;
    const grav = gravityAt(cur, ship.pos);
    g.simTime = t;
    autopilot(g, dt, grav); // (adds gravity and thrust to ship.vel)
    ship.pos.addScaledVector(ship.vel, dt);
    updateBodies(bodies, t + dt);
    if (settledAt < 0 && ap.settled) settledAt = t;
  }
  const lp = lagrangePoints(w)[k - 1];
  const perYear = settledAt < 0 || settledAt > secs - 3600 ? Infinity : ((spent - spentBefore) / 3600) * 365.25 * 86400;
  return { off: ship.pos.distanceTo(lp.pos), settledAt, perYear };
}

describe('holding at a Lagrange point (autopilot)', () => {
  it('flies to L4, settles on it, and then needs almost no thrust: it is a free orbit', () => {
    const r = fly(4, 7200);
    expect(r.settledAt).toBeGreaterThan(0);
    expect(r.off).toBeLessThan(200);
    expect(r.perYear).toBeLessThan(20); // (what's left is the step size's own error: ~3 cm off the point)
  });

  it('holds L1, which is unstable, at a few m/s a year: not the thousands the star alone would take', () => {
    const r = fly(1, 7200);
    expect(r.settledAt).toBeGreaterThan(0);
    expect(r.off).toBeLessThan(500);
    expect(r.perYear).toBeLessThan(50);
  });
});
