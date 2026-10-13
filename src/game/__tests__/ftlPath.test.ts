import { describe, expect, it, vi } from 'vitest';
import { newShip, type Game } from '../Game';
import { THREE } from '../lib/three';
import { apInsertion, ftlTransfer } from '../sim/autopilot';
import { dropAlt } from '../sim/ftl';
import { fieldOf, pathCost, planPath } from '../sim/ftlPath';
import { updateBodies } from '../sim/kepler';
import { updateStations } from '../sim/stations';
import type { Autopilot, Body, CurrentSystem, Star, Station, World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

// the drive's upkeep (exotic matter, the power bus) isn't what's tested here
vi.mock('../sim/ftl', async (orig) => ({
  ...(await orig<typeof import('../sim/ftl')>()),
  ftlUpkeep: () => true,
}));

function system(sys = homeSystem()) {
  const bodies = buildSystem(sys);
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  return { bodies, cur, home: findHome(bodies) as World };
}

/**
 * The autopilot's FTL leg to a hold 1,000 km over `to`, from `from`, nose on it and at rest: how
 * long it takes, how far from the drop point it ended (× the distance it drops out at), and the
 * closest it came to any world's drop-out altitude (× it).
 */
function leg(cur: CurrentSystem, to: Body, from: THREE.Vector3, st: Station | null = null) {
  const r0 = to.radius + 1000e3;
  const ap: Autopilot = st
    ? { body: to, type: 'rendezvous', station: st, r0: st.a, period: 0, n: null, point: null, phase: 'transfer', settled: false, t0: 0, prop0: 0 }
    : { body: to, type: 'hold', station: null, r0, period: 0, n: null, point: from.clone().sub(to.pos).setLength(r0), phase: 'transfer', settled: false, t0: 0, prop0: 0 };
  const ship = newShip();
  ship.mode = 'ftl';
  ship.ap = ap;
  ship.pos.copy(from);
  ship.q.setFromRotationMatrix(new THREE.Matrix4().lookAt(ship.pos, to.pos, new THREE.Vector3(0, 1, 0)));
  ship.ftlSpeed = 0;
  const g = { ship, cur, frameBody: cur.star, simTime: 0, fwd: new THREE.Vector3(), curSpeed: 0, warpFx: [], showMsg: () => {} } as unknown as Game;
  const dt = 1 / 30;
  let t = 0,
    closest = Infinity;
  for (; t < 900 && (ship.mode as string) !== 'normal'; t += dt) {
    g.simTime = t;
    updateBodies(cur.bodies, t); // (the star frame: the ship isn't carried)
    updateStations(cur.stations, t);
    ftlTransfer(g, dt);
    for (const b of cur.bodies) closest = Math.min(closest, (ship.pos.distanceTo(b.pos) - b.radius) / dropAlt(b));
  }
  const { P, rT } = apInsertion(ship, ap);
  return { dropped: (ship.mode as string) === 'normal', t, off: P.distanceTo(ship.pos) / Math.max(30e3, rT * 0.01), closest };
}

describe('the FTL leg\'s course round the gravity wells', () => {
  it('goes round the star, not past it, to a world on its far side', () => {
    const { cur, home } = system();
    const star = cur.star;
    // the same distance out on the far side of the star (a little off the line, as it would be)
    const from = star.pos.clone().sub(home.pos.clone().sub(star.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.05));
    const f = fieldOf(cur.bodies, home.pos.clone().addScaledVector(from.clone().sub(home.pos).normalize(), home.radius + 1000e3), 30e3);
    // skimming the star at its drop-out altitude (as the leg used to) versus the planned course
    const skim = star.pos.clone().add(new THREE.Vector3().crossVectors(from.clone().sub(star.pos), new THREE.Vector3(0, 1, 0)).setLength(star.radius + dropAlt(star) * 1.1));
    const tSkim = pathCost(f, [from, skim, f.P]);
    const planned = planPath(cur.bodies, from, f);
    const tPlan = pathCost(f, planned.pts);
    expect(tPlan).toBeLessThan(tSkim / 2);
    // and flown: it gets there, in about the time it planned, and clear of the star's well
    const r = leg(cur, home, from);
    expect(r.dropped).toBe(true);
    expect(r.off).toBeLessThan(1.05);
    expect(r.t).toBeLessThan(tPlan * 1.5 + 10);
    expect(r.t).toBeLessThan(tSkim / 2);
    let nearStar = Infinity;
    for (const p of planned.pts) nearStar = Math.min(nearStar, p.distanceTo(star.pos));
    expect(nearStar).toBeGreaterThan(0.3 * home.pos.distanceTo(star.pos));
  });

  it('never comes within a world\'s drop-out altitude on the way, from anywhere to anywhere', () => {
    const { cur, bodies } = system();
    const worlds = bodies.filter((b): b is World => b.kind === 'planet');
    for (const a of worlds)
      for (const b of worlds) {
        if (a === b) continue;
        const from = a.pos.clone().add(a.pos.clone().sub(cur.star.pos).setLength(a.radius + dropAlt(a) * 2));
        const r = leg(cur, b, from);
        expect(r.dropped).toBe(true);
        expect(r.closest).toBeGreaterThan(1);
      }
  });

  it('gets there clear of every world in the systems around home too (giants, moons, pairs of stars)', () => {
    for (const sys of systemsNear(homeSystem().pos, 25).slice(0, 8)) {
      const { cur, bodies } = system(sys);
      const worlds = bodies.filter((b): b is World => b.kind === 'planet');
      for (let i = 0; i + 1 < worlds.length; i += 2) {
        const a = worlds[i],
          b = worlds[worlds.length - 1 - i];
        if (a === b) continue;
        // (just out of a's mass lock, on the side away from its own star)
        const from = a.pos.clone().add(a.pos.clone().sub(a.parent.pos).setLength(a.radius + dropAlt(a) * 2));
        const r = leg(cur, b, from);
        expect(r.dropped, `${a.name} → ${b.name}`).toBe(true);
        expect(r.off, `${a.name} → ${b.name}`).toBeLessThan(1.05);
        expect(r.closest, `${a.name} → ${b.name}`).toBeGreaterThan(1);
      }
    }
  });

  it('goes round a world to a station on its far side, dropping out beside it, low ones too', () => {
    for (const sys of [homeSystem(), ...systemsNear(homeSystem().pos, 25).slice(0, 8)]) {
      const { cur } = system(sys);
      cur.stations = buildStations(cur.sys, cur.bodies);
      updateStations(cur.stations, 0);
      for (const st of cur.stations.filter((s) => !s.sky && !s.depot)) {
        const b = st.parent;
        const from = b.pos.clone().sub(st.pos.clone().sub(b.pos).setLength(b.radius * 20)); // (straight behind the world)
        const r = leg(cur, b, from, st);
        expect(r.dropped, st.name).toBe(true);
        expect(r.off, st.name).toBeLessThan(1.05);
        expect(r.closest, st.name).toBeGreaterThan(1);
      }
    }
  });
});
