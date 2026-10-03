import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot } from '../sim/autopilot';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { gatePoint, lagrangePoints } from '../sim/lagrange';
import type { Autopilot, CurrentSystem, Ship, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

// the thruster model needs a power bus and tanks; here thrust is just applied and its Δv summed
let spent = 0;
vi.mock('../sim/resources', async (orig) => ({
  ...(await orig<typeof import('../sim/resources')>()),
  deltaVLeft: () => 1e6,
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

describe('phasing transfer (autopilot)', () => {
  /** Run a whole transfer from the departure gate: fine steps for burns, the rails' leapfrog for the coast. */
  function transfer(k: 3 | 4 | 5, e: number, revs: number) {
    const bodies = buildSystem(homeSystem());
    const w = findHome(bodies) as World;
    w.orb.e = e;
    updateBodies(bodies, 0);
    const stars = bodies.filter((b): b is Star => b.kind === 'star');
    const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
    const gate = gatePoint(w, k);
    const ap: Autopilot = { body: w, type: 'lagrange', lk: k, revs, station: null, r0: 1, period: 0, n: null, point: null, phase: 'insert', settled: false, t0: 0, prop0: 0, ph: { stage: 'depart', tArr: 0, checks: [], dvLeft: null, resume: 1, spent: 0, stall: 0 } };
    const ship = { pos: gate.pos.clone(), vel: gate.vel.clone().sub(w.parent.vel), ap, mode: 'normal', ftlCharge: 0, avionics: { orbit: null } } as unknown as Ship;
    const g = { ship, frameBody: w.parent, cur, simTime: 0, warp: 1, showMsg: () => {}, invalidateHud: () => {} } as unknown as Game;
    spent = 0;
    let t = 0;
    let tHold = -1;
    const stages = new Set<string>();
    while (t < 10 * 365.25 * 86400) {
      if (ap.ph?.stage === 'coast') {
        // time warp's rails: kick–drift–kick (sim/timewarp.ts), the autopilot only watching the clock
        const dt = 600;
        ship.vel.addScaledVector(gravityAt(cur, ship.pos).vec, dt / 2);
        ship.pos.addScaledVector(ship.vel, dt);
        t += dt;
        updateBodies(bodies, t);
        ship.vel.addScaledVector(gravityAt(cur, ship.pos).vec, dt / 2);
        g.simTime = t;
        autopilot(g, 0, gravityAt(cur, ship.pos));
      } else {
        const dt = 0.05;
        g.simTime = t;
        autopilot(g, dt, gravityAt(cur, ship.pos));
        if (!ship.ap) break;
        ship.pos.addScaledVector(ship.vel, dt);
        t += dt;
        updateBodies(bodies, t);
      }
      stages.add(ap.ph!.stage);
      if (ap.settled && tHold < 0) tHold = t;
      if (tHold > 0 && t > tHold + 600) break;
    }
    const lp = lagrangePoints(w)[k - 1];
    return { off: ship.pos.distanceTo(lp.pos), relV: ship.vel.distanceTo(lp.vel.clone().sub(w.parent.vel)), tHold, spent: ap.ph!.spent, total: spent, stages, ap, P: (2 * Math.PI) / w.orb.n, settled: ap.settled };
  }

  it('flies from the gate to L4 in three orbits for about a kilometre a second, and holds there', () => {
    const r = transfer(4, 0.02, 3);
    expect(r.settled).toBe(true);
    expect(r.off).toBeLessThan(500);
    expect([...r.stages]).toEqual(expect.arrayContaining(['burn', 'coast', 'arrive']));
    // about (3 − 1/7) orbits of the planet's year, and Δv of the burn out (the burn back is the hold's)
    expect(r.tHold / r.P).toBeGreaterThan(2.5);
    expect(r.tHold / r.P).toBeLessThan(3);
    expect(r.spent).toBeGreaterThan(300);
    expect(r.spent).toBeLessThan(1000);
    expect(r.total).toBeLessThan(3000); // burn out, the matching on arrival, and small corrections: not the 40 km/s of going straight there
  });

  it('reaches L5 behind the planet and L3 opposite it', () => {
    for (const k of [5, 3] as const) {
      const r = transfer(k, 0, 4);
      expect(r.settled).toBe(true);
      expect(r.off).toBeLessThan(500);
    }
  });
});
