import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autodock } from '../sim/autodock';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { padOf, stationQuat, toLocal, whereIsAt } from '../sim/stationGeom';
import { stationState } from '../sim/stations';
import type { CurrentSystem, Ship, Star } from '../types';
import { JUMP_RANGE } from '../constants';
import { systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem, systemAnchor } from '../universe/system';

vi.mock('../sim/resources', async (orig) => ({ ...(await orig<typeof import('../sim/resources')>()), applyThrust: () => {} }));

describe('the docking computer at a depot', () => {
  it('flies from the hold point down onto a pad on the plate, upright and gently, through the real autodock', () => {
    let found: { st: ReturnType<typeof buildStations>[number]; bodies: ReturnType<typeof buildSystem>; sys: ReturnType<typeof systemsNear>[number] } | null = null;
    for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE)) {
      const bodies = buildSystem(sys);
      const st = buildStations(sys, bodies).find((x) => x.depot);
      if (st) {
        found = { st, bodies, sys };
        break;
      }
    }
    const { st, bodies, sys } = found!;
    const t0 = 3e6;
    updateBodies(bodies, t0);
    stationState(st, t0);
    const stars = bodies.filter((b): b is Star => b.kind === 'star');
    const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [st] };
    const star = stars[0];
    const q = stationQuat(st, t0);
    const pad = padOf(st, 0);
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // start 1.2 km over the plate's middle, at rest against the depot, nose along the station's -z-ish
    const start = st.pos.clone().add(new THREE.Vector3(0.3 * st.size, 0, 0).applyQuaternion(q)).addScaledVector(up, st.size * 0.9 + 200);
    const ship = { pos: start, vel: st.vel.clone().sub(star.vel), q: new THREE.Quaternion(), ap: null, mode: 'normal', ftlCharge: 0, avionics: { dock: { model: 'WD', name: 'test', caps: { clearance: true, approachSpeed: 150, insideSpeed: 60, launch: true, range: 50e3 } } } } as unknown as Ship;
    const g = {
      ship,
      frameBody: star,
      cur,
      simTime: t0,
      warp: 1,
      dock: { station: st, pad: 0, docked: false },
      dockRequest: null,
      autodock: { phase: 'hold' },
      autodockStation: st,
      autodockPad: 0,
      dockRel: new THREE.Vector3(),
      inStation: null,
      inStationRel: new THREE.Vector3(),
      traffic: [],
      showMsg: () => {},
      invalidateHud: () => {},
      warned: {},
    } as unknown as Game;
    const dt = 0.05;
    let t = 0;
    let lastPhase = '';
    const phases: string[] = [];
    let closest = Infinity,
      speedAtClosest = Infinity;
    for (; t < 900; t += dt) {
      g.simTime = t0 + t;
      g.dockRel.subVectors(ship.pos, st.pos);
      if (!g.autodock) break;
      autodock(g, dt, gravityAt(cur, ship.pos).vec);
      ship.pos.addScaledVector(ship.vel, dt);
      updateBodies(bodies, t0 + t + dt);
      stationState(st, t0 + t + dt);
      if (g.autodock && g.autodock.phase !== lastPhase) {
        lastPhase = g.autodock.phase;
        phases.push(lastPhase);
      }
      // height over the pad, and speed against the station
      const p = toLocal(st, g.simTime, ship.pos);
      const h = (p.z - 0) * st.size;
      const lateral = Math.hypot(p.x - pad.pos.x, p.y - pad.pos.y);
      if (lateral < 0.04 && h < closest) {
        closest = h;
        speedAtClosest = ship.vel.clone().add(star.vel).sub(st.vel).length();
      }
      if (h < 12 && lateral < 0.04) break;
    }
    // it came down onto the pad, slowly, and never through the plate
    expect(phases).toEqual(expect.arrayContaining(['enter', 'descend']));
    expect(closest).toBeLessThan(12);
    expect(speedAtClosest).toBeLessThan(6);
    // upright: the ship's top along the pad's up
    const topUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q).dot(up);
    expect(topUp).toBeGreaterThan(0.85);
    // and over the plate, not the spine or the open space beside it
    const p = toLocal(st, g.simTime, ship.pos);
    expect(Math.hypot(p.x - pad.pos.x, p.y - pad.pos.y)).toBeLessThan(0.04);
    expect(whereIsAt(st, p.clone().setZ(-0.005), 0.002)).toBe('wall');
  });
});
