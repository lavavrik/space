import { describe, expect, it } from 'vitest';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { coastFTL } from '../sim/ftl';

/** Just enough of a game for coastFTL: a ship coasting along +x, and one world `clear` m ahead. */
function scene(v: number, clear: number) {
  const ship = { pos: new THREE.Vector3(), travelDir: new THREE.Vector3(1, 0, 0), ftlCoast: v };
  const world = { pos: new THREE.Vector3(clear + 1e6, 0, 0), radius: 1e6 };
  return { ship, cur: { bodies: [world], stations: [] } } as unknown as Game;
}

describe('dropping out of FTL', () => {
  it('coasts on, fading over a couple of seconds in open space', () => {
    const g = scene(3e6, 1e15);
    let t = 0;
    for (; t < 0.5; t += 1 / 60) coastFTL(g, 1 / 60);
    expect(g.ship.ftlCoast).toBeGreaterThan(3e6 * 0.2); // still going after half a second
    for (; t < 3; t += 1 / 60) coastFTL(g, 1 / 60);
    expect(g.ship.ftlCoast).toBeLessThan(3e6 * 0.002); // all but gone after three
    expect(Math.abs(g.ship.pos.x / (3e6 / 2.3) - 1)).toBeLessThan(0.01); // v / k
  });

  it('never coasts more than a fifth of the way to a world ahead', () => {
    const clear = 2e7;
    const g = scene(3e8, clear);
    for (let i = 0; i < 600; i++) coastFTL(g, 1 / 60);
    expect(g.ship.pos.x).toBeLessThanOrEqual(0.2 * clear * 1.01);
    expect(g.ship.ftlCoast).toBe(0);
  });
});
