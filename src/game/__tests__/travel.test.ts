import { describe, expect, it, vi } from 'vitest';
import { newShip, type Game } from '../Game';
import { THREE } from '../lib/three';
import { travelToTarget } from '../sim/planner';
import { updateBodies } from '../sim/kepler';
import type { CurrentSystem, Star, Target, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

// the maneuver guide's panel isn't what's tested here
vi.mock('../sim/guide', async (orig) => ({ ...(await orig<typeof import('../sim/guide')>()), startOrbitGuide: () => {} }));

/** Out in the open 1 AU from home's world, with `target` targeted. */
function setup(target: (cur: CurrentSystem, home: World) => Target | null) {
  const sys = homeSystem();
  const bodies = buildSystem(sys);
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: buildStations(sys, bodies) };
  const home = findHome(bodies) as World;
  const ship = newShip();
  ship.pos.copy(home.pos).add(new THREE.Vector3(0, 1.5e11, 0));
  const msgs: string[] = [];
  const g = { ship, cur, target: target(cur, home), route: null, dock: null, jump: null, inStation: false, planner: null, simTime: 0, invalidateHud: () => {}, showMsg: (m: string) => msgs.push(m) } as unknown as Game;
  travelToTarget(g);
  return { g, ship, home, msgs };
}

describe('travel to the target (Shift+G)', () => {
  it('a world: the planner\'s default orbit round it, charging the FTL drive for the leg', () => {
    const { ship, home } = setup((_, h) => h);
    expect(ship.ap?.body).toBe(home);
    expect(ship.ap?.type).toBe(ship.avionics.orbit!.caps.types[0]);
    expect(ship.ap?.phase).toBe('charge');
  });

  it('a station: a rendezvous with it', () => {
    const { ship } = setup((cur) => cur.stations[0]);
    expect(ship.ap?.type).toBe('rendezvous');
    expect(ship.ap?.station).toBeTruthy();
  });

  it('nothing, or a ship: says why not and leaves the ship alone', () => {
    for (const t of [() => null, () => ({ kind: 'ship', name: 'Hauler' }) as unknown as Target]) {
      const { ship, msgs } = setup(t);
      expect(ship.ap).toBeNull();
      expect(msgs.length).toBe(1);
    }
  });
});
