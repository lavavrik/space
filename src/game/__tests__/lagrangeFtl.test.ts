import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { ftlTransfer } from '../sim/autopilot';
import { updateBodies } from '../sim/kepler';
import { gatePoint, lagrangePoints } from '../sim/lagrange';
import type { Autopilot, CurrentSystem, Ship, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

const drops: number[] = [];
vi.mock('../sim/ftl', async (orig) => ({
  ...(await orig<typeof import('../sim/ftl')>()),
  ftlUpkeep: () => true,
  ftlSpeedLimit: () => 3e8,
  dropFTL: () => {
    drops.push(1);
  },
}));

/** The autopilot's FTL leg to a point on the move: it must catch it and drop out (it once chased a planet-speed target at a steady 40 km, forever). */
function leg(k: 1 | 2 | 3 | 4 | 5, depart: boolean, start: number) {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  const target = depart ? gatePoint(w, k as 3) : lagrangePoints(w)[k - 1];
  const ap = { body: w, type: 'lagrange', lk: k, station: null, r0: 0, period: 0, n: null, point: null, phase: 'transfer', settled: false, t0: 0, prop0: 0, ph: depart ? { stage: 'depart' } : undefined } as unknown as Autopilot;
  const ship = {
    pos: target.pos.clone().add(new THREE.Vector3(start, 0, 0)),
    vel: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    ap,
    mode: 'ftl',
    ftlSpeed: 0,
    avionics: { orbit: null },
  } as unknown as Ship;
  const g = { ship, cur, frameBody: w.parent, simTime: 0, fwd: new THREE.Vector3(), curSpeed: 0, showMsg: () => {} } as unknown as Game;
  drops.length = 0;
  const dt = 0.016;
  let t = 0;
  while (!drops.length && t < 3600) {
    t += dt;
    g.simTime = t;
    updateBodies(bodies, t);
    ftlTransfer(g, dt);
  }
  return { t, dropped: drops.length > 0, off: ship.pos.distanceTo((depart ? gatePoint(w, k as 3) : lagrangePoints(w)[k - 1]).pos) };
}

describe('the FTL leg to a Lagrange point', () => {
  for (const [k, depart] of [[2, false], [1, false], [4, false], [4, true]] as const) {
    it(`reaches L${k}${depart ? "'s departure gate" : ''} and drops out within 30 km, though the point moves at the planet's speed`, () => {
      const r = leg(k, depart, 3e10);
      expect(r.dropped).toBe(true);
      expect(r.off).toBeLessThan(30e3 * 1.5);
    });
  }
});
