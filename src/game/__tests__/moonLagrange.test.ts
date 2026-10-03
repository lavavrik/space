import { describe, expect, it, vi } from 'vitest';
import { JUMP_RANGE } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot } from '../sim/autopilot';
import { gravityAt } from '../sim/gravity';
import { railAcc, updateBodies } from '../sim/kepler';
import { gatePoint, hillRatio, lagrangePoints, phasingReaches } from '../sim/lagrange';
import { lpointsShown } from '../sim/lpoints';
import { scanKey } from '../sim/scanner';
import type { Autopilot, Body, CurrentSystem, Ship, Star, StarSystem, World } from '../types';
import { systemsNear } from '../universe/galaxy';
import { buildSystem, systemAnchor } from '../universe/system';

// the thruster model needs a power bus and tanks; here thrust is just applied and its Δv summed
let spent = 0;
vi.mock('../sim/resources', async (orig) => ({
  ...(await orig<typeof import('../sim/resources')>()),
  deltaVLeft: () => 1e6,
  applyThrust: (_g: unknown, T: THREE.Vector3) => {
    spent += T.length();
  },
}));

function curOf(sys: StarSystem, bodies: Body[]): CurrentSystem {
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  return { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
}

/** The first moon nearby that `pick` accepts, in a fresh system with the bodies at t = 0. */
function moonWhere(pick: (m: World) => boolean) {
  for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE)) {
    const bodies = buildSystem(sys);
    const m = bodies.find((b): b is World => b.kind === 'moon' && pick(b));
    if (!m) continue;
    m.orb.e = 0; // (a circular orbit: the points are exact; the eccentric case is the planets' tests')
    updateBodies(bodies, 0);
    return { sys, bodies, m, cur: curOf(sys, bodies) };
  }
  throw new Error('no such moon nearby');
}
const q = (m: World) => m.mu / m.parent.mu;
/** A light moon: phasing reaches its L4, and its L1 lies outside its SOI. */
const light = () => moonWhere((m) => q(m) > 1e-6 && q(m) < 1e-4 && m.orb.a > 30 * m.radius);
/** A heavy one: its L1 lies inside its own SOI (in its frame, where the planet's pull comes as a tide), and no phasing to L4. */
const heavy = () => moonWhere((m) => lagrangePoints(m)[0].pos.distanceTo(m.pos) < m.soi && !phasingReaches(m, 4));

/**
 * Step a ship as the game does (sim/update.ts): the clock and the bodies to the step's end, the ship
 * carried with its frame body, the frame switched where the SOI says, then `fly` (which adds gravity
 * and thrust to the frame-relative velocity), then the move.
 */
function stepper(bodies: Body[], cur: CurrentSystem, g: Game) {
  return (t: number, dt: number, fly: (grav: ReturnType<typeof gravityAt>) => void) => {
    const fb = g.frameBody;
    const off = g.ship.pos.clone().sub(fb.pos);
    g.simTime = t + dt;
    updateBodies(bodies, t + dt);
    g.ship.pos.copy(fb.pos).add(off);
    const grav = gravityAt(cur, g.ship.pos);
    if (grav.body !== fb) {
      g.ship.vel.add(fb.vel).sub(grav.body.vel);
      g.frameBody = grav.body;
    }
    fly(grav);
    g.ship.pos.addScaledVector(g.ship.vel, dt);
  };
}

describe('Lagrange points of moons', () => {
  it('are balance points of the force a ship feels: one left at L1, L2 or L4 keeps pace with no thrust', () => {
    for (const { m, cur, bodies } of [light(), heavy()]) {
      const n = m.orb.n;
      for (const k of [1, 2, 4] as const) {
        updateBodies(bodies, 0);
        const lp = lagrangePoints(m)[k - 1];
        const pos = lp.pos.clone(),
          v = lp.vel.clone();
        // a tenth of the e-fold of the unstable points' drift (1 / 2.53 n), fine steps; absolute frame
        const T = 0.1 / (2.53 * n),
          dt = T / 2000;
        const acc = (p: THREE.Vector3) => {
          const gr = gravityAt(cur, p);
          return gr.vec.add(railAcc(gr.body));
        };
        for (let t = 0; t < T; t += dt) {
          v.addScaledVector(acc(pos), dt / 2);
          pos.addScaledVector(v, dt);
          updateBodies(bodies, t + dt);
          v.addScaledVector(acc(pos), dt / 2);
        }
        const off = pos.distanceTo(lagrangePoints(m)[k - 1].pos);
        // against where a ship 1 % of the way to the moon would get to, pulled at the point's unbalanced rate
        const d = lp.pos.distanceTo(m.pos);
        expect(off / d, `${m.name} L${k}`).toBeLessThan(2e-3);
      }
    }
  });

  it('are held by the autopilot, flown in the planet\'s (or the moon\'s) frame: it settles on L1, L2 and L4', () => {
    for (const s of [light(), heavy()]) {
      for (const k of [1, 2, 4] as const) {
        const { m, cur, bodies } = s;
        updateBodies(bodies, 0);
        const lp = lagrangePoints(m)[k - 1];
        const fb = gravityAt(cur, lp.pos).body;
        const ap: Autopilot = { body: m, type: 'lagrange', lk: k, station: null, r0: 1, period: 0, n: null, point: null, phase: 'insert', settled: false, t0: 0, prop0: 0 };
        // 30 km off, at rest relative to the moon (as an FTL drop leaves the ship)
        const ship = { pos: lp.pos.clone().add(new THREE.Vector3(3e4, 0, 0)), vel: m.vel.clone().sub(fb.vel), ap, mode: 'normal', ftlCharge: 0, avionics: { orbit: null } } as unknown as Ship;
        const g = { ship, frameBody: fb, cur, simTime: 0, showMsg: () => {} } as unknown as Game;
        const step = stepper(bodies, cur, g);
        spent = 0;
        let t = 0,
          settledAt = -1,
          late = -1;
        const dt = 1 / 60;
        for (; t < 3600; t += dt) {
          step(t, dt, (grav) => autopilot(g, dt, grav));
          if (ap.settled && settledAt < 0) settledAt = t;
          if (settledAt >= 0 && t > settledAt + 600) break;
          if (settledAt >= 0 && t > settledAt + 300 && late < 0) late = spent;
        }
        const label = `${m.name} L${k}`;
        expect(settledAt, label).toBeGreaterThan(0);
        expect(ship.pos.distanceTo(lagrangePoints(m)[k - 1].pos), label).toBeLessThan(100);
        // then holding: next to nothing once the last trim is done (the five minutes after settling
        // close the last 100 m and 5 m/s; a heavy moon's L4 sits in its pull's taper, which costs a little)
        expect(spent - late, label).toBeLessThan(1);
      }
    }
  });

  it('a phasing transfer reaches a light moon\'s L4 round its planet; a heavy moon\'s L4 is flown to straight', () => {
    const { m, cur, bodies } = light();
    expect(phasingReaches(m, 4)).toBe(true);
    const par = m.parent;
    const gate = gatePoint(m, 4);
    const ap: Autopilot = { body: m, type: 'lagrange', lk: 4, revs: 3, station: null, r0: 1, period: 0, n: null, point: null, phase: 'insert', settled: false, t0: 0, prop0: 0, ph: { stage: 'depart', tArr: 0, checks: [], dvLeft: null, resume: 1, spent: 0, stall: 0 } };
    const ship = { pos: gate.pos.clone(), vel: gate.vel.clone().sub(par.vel), ap, mode: 'normal', ftlCharge: 0, avionics: { orbit: null } } as unknown as Ship;
    const g = { ship, frameBody: par, cur, simTime: 0, warp: 1, showMsg: () => {}, invalidateHud: () => {} } as unknown as Game;
    const step = stepper(bodies, cur, g);
    const P = (2 * Math.PI) / m.orb.n;
    let t = 0,
      tHold = -1;
    const stages = new Set<string>();
    while (t < 10 * P && ship.ap) {
      // coasting: the rails' kind of step (the autopilot only watches the clock); otherwise fine steps
      const dt = ap.ph?.stage === 'coast' ? Math.min(60, P / 2000) : 1 / 20;
      step(t, dt, (grav) => (ap.ph?.stage === 'coast' ? ship.vel.addScaledVector(grav.vec, dt) && autopilot(g, 0, grav) : autopilot(g, dt, grav)));
      t += dt;
      if (ap.ph) stages.add(ap.ph.stage);
      if (ap.settled && tHold < 0) tHold = t;
      if (tHold > 0 && t > tHold + 300) break;
    }
    expect(ship.ap).toBeTruthy();
    expect([...stages]).toEqual(expect.arrayContaining(['burn', 'coast', 'arrive']));
    expect(ap.settled).toBe(true);
    expect(ship.pos.distanceTo(lagrangePoints(m)[3].pos)).toBeLessThan(500);
    expect(tHold / P).toBeGreaterThan(2);
    expect(tHold / P).toBeLessThan(3.2);

    const h = heavy().m;
    expect(phasingReaches(h, 4)).toBe(false);
    expect(phasingReaches(h, 3)).toBe(true);
    expect(7 * hillRatio(q(h))).toBeGreaterThan(Math.PI / 3 - 0.15);
  });

  it('show when their moon is targeted, round it', () => {
    const { m, cur } = light();
    const seen = new Set<string>([scanKey(cur.sys, m)]);
    const g = { cur, simTime: 0, radar: { seen }, scans: new Map(), target: m } as unknown as Game;
    const pts = lpointsShown(g);
    expect(pts.map((p) => p.name)).toEqual([1, 2, 3, 4, 5].map((k) => `${m.name} L${k}`));
    g.target = pts[1];
    expect(lpointsShown(g)).toContain(pts[1]);
  });
});
