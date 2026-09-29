import { describe, expect, it } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { BOARD_S, MAX_ACTIVE, PENALTY, abandon, accept, board, cantTake, deliverMetal, updateContracts, type Contract } from '../sim/contracts';
import { cargoMass } from '../sim/economy';
import type { Station } from '../types';

const st = (name: string, x: number) => ({ name, pos: new THREE.Vector3(x, 0, 0) }) as Station;
const A = st('Alpha Port', 0),
  B = st('Beta Hub', 1.5e11);
/** Just what the contracts touch: one system, two stations, docked at A. */
function fake(): Game {
  return {
    cur: { sys: { id: '0,0,0:0', name: 'Home', pos: new THREE.Vector3() }, stations: [A, B] },
    nearby: [],
    simTime: 100,
    credits: 10_000,
    contracts: [] as Contract[],
    contractsSeen: new Set<string>(),
    ship: { cargo: {}, crates: {} },
    dock: { station: A, pad: 0, docked: true },
    warned: {},
    showMsg() {},
  } as unknown as Game;
}
/** A board with a haul on it (the board is a hash: step the clock until one comes up). */
function withJob(g: Game, kind: Contract['kind']) {
  for (let k = 0; k < 200; k++) {
    const c = board(g, A).find((x) => x.kind === kind);
    if (c) return c;
    g.simTime += BOARD_S;
  }
  throw new Error(`no ${kind} on 200 boards`);
}

describe('contracts', () => {
  it('a board is the same for its period, then a new one', () => {
    const g = fake();
    const a = board(g, A),
      b = board(g, A);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.length).toBeGreaterThan(0);
    g.simTime += BOARD_S;
    expect(board(g, A)[0].id).not.toBe(a[0].id);
  });

  it('a haul loads its crates into the hold, and pays on docking at its destination', () => {
    const g = fake();
    const c = withJob(g, 'haul');
    accept(g, c);
    expect(cargoMass(g)).toBe(c.kg);
    expect(board(g, A).some((x) => x.id === c.id)).toBe(false); // not offered again
    updateContracts(g); // still here: nothing happens
    expect(g.contracts.length).toBe(1);
    g.dock = { station: B, pad: 2, docked: true } as Game['dock'];
    const before = g.credits;
    updateContracts(g);
    expect(g.contracts.length).toBe(0);
    expect(g.credits).toBe(before + c.reward);
    expect(cargoMass(g)).toBe(0);
  });

  it('out of time: the job fails, the crates go back, and the penalty is paid', () => {
    const g = fake();
    const c = withJob(g, 'haul');
    accept(g, c);
    g.dock = null;
    g.simTime = g.contracts[0].deadline + 1;
    const before = g.credits;
    updateContracts(g);
    expect(g.contracts.length).toBe(0);
    expect(cargoMass(g)).toBe(0);
    expect(g.credits).toBeCloseTo(before - c.reward * PENALTY);
  });

  it('a metal order is handed over from the hold, only with enough of it', () => {
    const g = fake();
    const c = withJob(g, 'metal');
    accept(g, c);
    const job = g.contracts[0];
    g.ship.cargo[c.commodity!] = c.kg / 2;
    deliverMetal(g, job);
    expect(g.contracts.length).toBe(1);
    g.ship.cargo[c.commodity!] = c.kg + 5;
    deliverMetal(g, job);
    expect(g.contracts.length).toBe(0);
    expect(g.ship.cargo[c.commodity!]).toBeCloseTo(5);
  });

  it(`holds at most ${MAX_ACTIVE} jobs, and a haul needs room in the hold`, () => {
    const g = fake();
    const c = withJob(g, 'haul');
    g.ship.cargo.nife = 200_000;
    expect(cantTake(g, c)).toMatch(/room/);
    g.ship.cargo = {};
    for (let i = 0; i < MAX_ACTIVE; i++) g.contracts.push({ ...c, id: `x${i}` });
    expect(cantTake(g, c)).toMatch(/jobs already/);
    abandon(g, g.contracts[0]);
    expect(cantTake(g, c)).toBeNull();
  });
});
