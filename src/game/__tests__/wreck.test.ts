import { describe, expect, it } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { CARGO_CAP } from '../sim/economy';
import { leaveWreck, updateWrecks, wreckMetal } from '../sim/wreck';
import type { World } from '../types';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
/** A bare world (no terrain: a smooth sphere), and a ship on a circular orbit round it. */
function fake(cargo: Record<string, number>): Game {
  const w = { kind: 'planet', name: 'Testworld', radius: 6e6, mu: 4e14, pos: V(), vel: V(), axis: V(0, 1, 0), spin: 0, rot: 0, type: 0, seed: 1, tilt: 0 } as unknown as World;
  const r = 8e6;
  const ship = { pos: V(r, 0, 0), vel: V(0, 0, Math.sqrt(4e14 / r)), cargo: { ...cargo }, crates: {}, landed: null, dead: null, mode: 'normal' };
  return {
    ship,
    frameBody: w,
    cur: { sys: { id: 's' }, bodies: [w] },
    simTime: 0,
    wrecks: [],
    warned: {},
    target: null,
    traffic: [],
    showMsg() {},
  } as unknown as Game;
}

describe('wrecks', () => {
  it("a lost ship with metal leaves a wreck that stays in its orbit; one with an empty hold doesn't", () => {
    const g = fake({ nife: 30_000, pgm: 500 });
    leaveWreck(g);
    expect(g.wrecks.length).toBe(1);
    const w = g.wrecks[0];
    expect(wreckMetal(w)).toBeCloseTo(30_500);
    // a quarter of an orbit, in frame-sized steps: still on its circle (leapfrog, 2 s steps)
    const T = 2 * Math.PI * Math.sqrt(8e6 ** 3 / 4e14);
    for (let t = 0; t < T / 4; t += 0.5) updateWrecks(g, 0.5);
    expect(w.rel.length()).toBeGreaterThan(8e6 * 0.999);
    expect(w.rel.length()).toBeLessThan(8e6 * 1.001);
    expect(w.rel.x).toBeLessThan(1e6); // it went round
    const empty = fake({});
    leaveWreck(empty);
    expect(empty.wrecks.length).toBe(0);
  });

  it('salvage: alongside and matched, the metal comes across, as far as the hold has room', () => {
    const g = fake({ nife: 30_000 });
    leaveWreck(g);
    g.ship.cargo = { cobalt: CARGO_CAP - 10_000 }; // the replacement's hold: 10 t of room
    const w = g.wrecks[0];
    g.ship.pos.copy(w.pos).add(V(0, 50, 0));
    g.ship.vel.copy(w.vel).add(V(30, 0, 0)); // too fast past it
    updateWrecks(g, 0.02);
    expect(wreckMetal(w)).toBeCloseTo(30_000);
    g.ship.pos.copy(w.pos).add(V(0, 50, 0));
    g.ship.vel.copy(w.vel);
    updateWrecks(g, 0.02);
    expect(g.ship.cargo.nife).toBeCloseTo(10_000, -1);
    expect(wreckMetal(w)).toBeCloseTo(20_000, -1);
    g.ship.cargo = {};
    g.ship.pos.copy(w.pos);
    g.ship.vel.copy(w.vel);
    updateWrecks(g, 0.02);
    expect(g.wrecks.length).toBe(0); // stripped
  });
});
