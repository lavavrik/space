import { describe, expect, it } from 'vitest';
import type { Game } from '../Game';
import { AU, WT } from '../constants';
import { THREE } from '../lib/three';
import { bestOutfit, emptyOutfit } from '../outfit/catalog';
import { COSMIC, DOSE, HULL_T, radiationOutside, timeToFatal, updateRadiation } from '../sim/radiation';
import type { Body, Star, World } from '../types';
import { coreSystem } from '../universe/core';
import { buildSystem } from '../universe/system';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Just what the radiation code reads of a game: the ship at `pos`, these bodies, the suns' flux there. */
function fakeGame(bodies: Body[], pos: THREE.Vector3, outfit = emptyOutfit()) {
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const suns = stars.map((star) => ({ star, flux: star.L * (AU / pos.distanceTo(star.pos)) ** 2, sunlit: 1, toS: V() }));
  const msgs: string[] = [];
  const g = {
    ship: { pos, outfit, breakers: { shield: true }, dose: 0, dead: null },
    power: { suns, shieldKW: 0, left: 1e6, limited: null },
    cur: { bodies },
    inStation: null,
    dock: null,
    warned: {} as Record<string, boolean>,
    showMsg: (t: string) => msgs.push(t),
    frameBody: bodies[0],
    rad: null,
  };
  return { g: g as unknown as Game, msgs };
}

const sun = (): Star => ({ kind: 'star', name: 'Sol', typeName: 'G2 V star', radius: 6.957e8, pos: V(), vel: V(), seed: 1, mass: 2e30, mu: 1.327e20, soi: Infinity, spin: 0, axis: V(0, 1, 0), rot: 0, color: new THREE.Color(1, 1, 1), L: 1 });

function jupiter(at: THREE.Vector3): World {
  return { kind: 'planet', name: 'Jove', typeName: 'Gas giant', type: WT.GasGiant, radius: 7e7, pos: at, vel: V(), seed: 2, mass: 1.898e27, mu: 1.267e17, soi: 4e10, spin: 1.7e-4, axis: V(0, 1, 0), rot: 0, pal: { atmo: null } } as unknown as World;
}

describe('radiation', () => {
  it('is a gentle background at 1 AU from a Sun-like star', () => {
    const { g } = fakeGame([sun()], V(AU, 0, 0));
    updateRadiation(g, 1, false);
    const r = g.rad!;
    expect(r.outside).toBeCloseTo(COSMIC + 0.02 + 0.01, 3); // cosmic + wind + UV/X at Earth's flux
    expect(r.inside).toBeLessThan(0.06); // ~1.3 mSv/day
    expect(r.inside).toBeGreaterThan(COSMIC * HULL_T.cosmic * 0.9);
  });

  it("peaks in a Jupiter's belts, which the deflector mostly turns away", () => {
    const at = V(5 * AU, 0, 0);
    const p = at.clone().add(V(2.5 * 7e7, 0, 0)); // on the magnetic equator, at the peak
    const bare = fakeGame([sun(), jupiter(at)], p.clone());
    updateRadiation(bare.g, 1, false);
    const belt = bare.g.rad!.sources.find((s) => s.name.includes('belts'))!;
    expect(belt.rate).toBeCloseTo(3000, -1);
    expect(bare.g.rad!.inside).toBeGreaterThan(250); // the hull alone: ~300 mSv/h
    const shielded = fakeGame([sun(), jupiter(at)], p.clone(), bestOutfit());
    updateRadiation(shielded.g, 1, false);
    expect(shielded.g.rad!.inside).toBeLessThan(bare.g.rad!.inside * 0.05);
    // over the pole, far less
    const pole = fakeGame([sun(), jupiter(at)], at.clone().add(V(0, 2.5 * 7e7, 0)));
    expect(radiationOutside(pole.g, false).sources.find((s) => s.name.includes('belts'))!.rate).toBeLessThan(belt.rate * 0.25);
  });

  it("is mild where you arrive at the galactic core, and deadly well inside", () => {
    const bodies = buildSystem(coreSystem());
    const far = fakeGame(bodies, V(150 * AU, 0, 0));
    updateRadiation(far.g, 1, false);
    expect(far.g.rad!.inside).toBeGreaterThan(5);
    expect(far.g.rad!.inside).toBeLessThan(20);
    expect(timeToFatal(0, far.g.rad!.inside)).toBeNull(); // (it heals faster than it builds)
    const near = fakeGame(bodies, V(20 * AU, 0, 0));
    updateRadiation(near.g, 1, false);
    const t = timeToFatal(0, near.g.rad!.inside)!;
    expect(t / 3600).toBeGreaterThan(3);
    expect(t / 3600).toBeLessThan(24);
    // the deflector doesn't help with X-rays
    const shielded = fakeGame(bodies, V(20 * AU, 0, 0), bestOutfit());
    updateRadiation(shielded.g, 1, false);
    expect(shielded.g.rad!.inside).toBeGreaterThan(near.g.rad!.inside * 0.95);
  });

  it('builds a dose and warns at each limit', () => {
    const at = V(5 * AU, 0, 0);
    const { g, msgs } = fakeGame([sun(), jupiter(at)], at.clone().add(V(2.5 * 7e7, 0, 0)));
    // (destroyShip needs a whole game: stop just past the severe limit, short of the fatal one)
    for (let i = 0; i < 200 && g.ship.dose < DOSE.severe; i++) updateRadiation(g, 600, false);
    expect(g.ship.dose).toBeGreaterThan(DOSE.severe);
    expect(g.ship.dose).toBeLessThan(DOSE.fatal);
    expect(msgs.some((m) => m.includes('elevated'))).toBe(true);
    expect(msgs.some((m) => m.includes('sickness'))).toBe(true);
    expect(msgs.some((m) => m.includes('severe'))).toBe(true);
  });

  it('heals by half in two days', () => {
    const { g } = fakeGame([], V());
    g.power.suns = [];
    g.ship.dose = 1;
    // (no sources but cosmic rays, inside a station: nothing in)
    (g as unknown as { inStation: unknown }).inStation = { name: 'Dock' };
    for (let i = 0; i < 48; i++) updateRadiation(g, 3600, false);
    expect(g.ship.dose).toBeCloseTo(0.5, 2);
    expect(g.rad!.inside).toBe(0);
  });
});
