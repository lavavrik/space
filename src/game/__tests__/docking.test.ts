import { describe, expect, it } from 'vitest';
import { HANGAR_R, PAD_COUNT, PAD_R, padLocal, spinRateFor, whereIs } from '../sim/stationGeom';
import { THREE } from '../lib/three';
import { HOLD_OUT, clearPath } from '../sim/autodock';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('station geometry', () => {
  it('classifies points around the slot, tunnel and hangar', () => {
    const m = 8 / 1000;
    expect(whereIs(v(0, 0, 0.8), m)).toBe('outside');
    expect(whereIs(v(0, 0, 0.45), m)).toBe('tunnel'); // in the slot
    expect(whereIs(v(0.3, 0, 0.45), m)).toBe('wall'); // front face beside the slot
    expect(whereIs(v(0, 0, 0), m)).toBe('hangar');
    expect(whereIs(v(HANGAR_R - 0.001, 0, 0), m)).toBe('wall'); // too close to the hangar wall
    expect(whereIs(v(0.47, 0.47, 0), m)).toBe('wall'); // in the hull behind the hangar
  });

  it('puts every pad on the hangar wall with room between them', () => {
    const pads = Array.from({ length: PAD_COUNT }, (_, i) => padLocal(i));
    for (const p of pads) expect(Math.hypot(p.pos.x, p.pos.y)).toBeCloseTo(HANGAR_R, 6);
    for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) expect(pads[i].pos.distanceTo(pads[j].pos)).toBeGreaterThan(2 * PAD_R);
  });

  it('spins for about half a g on the wall', () => {
    const w = spinRateFor(1000);
    expect((w * w * HANGAR_R * 1000) / 9.81).toBeCloseTo(0.5, 5);
  });

  it("the docking computer's path to the hold point: straight when clear, round the station when not", () => {
    const S = 1407; // Rubin Hub: big enough that its hold point sits inside the keep-out sphere
    const hold = new THREE.Vector3(0, 0, S / 2 + HOLD_OUT);
    // out on the slot's axis: straight in (it used to park here for good)
    expect(clearPath(new THREE.Vector3(0, 0, 14_000), hold, S)).toEqual(hold);
    // behind the station: round it, never through
    const p = new THREE.Vector3(0, 0, -14_000);
    const way = clearPath(p, hold, S);
    expect(way.equals(hold)).toBe(false);
    expect(way.length()).toBeGreaterThanOrEqual(S * 0.87);
  });
});
