import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { FtlTrail, TRAIL_S } from '../render/Trail';

const V = (x: number, y = 0, z = 0) => new THREE.Vector3(x, y, z);
/** The drawn vertices (camera-relative to the origin) and their fades. */
function drawn(tr: FtlTrail, t: number) {
  tr.draw(V(0), t);
  const n = tr.count;
  const p = tr.pos,
    f = tr.fade;
  return Array.from({ length: n }, (_, i) => ({ p: V(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]), fade: f[i] }));
}

describe('FTL trail', () => {
  it('grows out from where the drive started, instead of appearing at full length', () => {
    const tr = new FtlTrail();
    const v = 1e9; // m/s
    for (let i = 0; i <= 20; i++) tr.record(V(v * i * 0.1), V(1), true, i * 0.1);
    const pts = drawn(tr, 2);
    // head at the ship, tail at the start point: 2 s of travel, not 30
    expect(pts[0].p.x).toBeCloseTo(2e9, -6);
    expect(pts[pts.length - 1].p.x).toBeCloseTo(0, -6);
  });

  it('bends where the ship turned (the old line swung round with it)', () => {
    const tr = new FtlTrail();
    let t = 0;
    const p = V(0);
    for (; t < 2; t += 0.1) tr.record(p.addScaledVector(V(1), 1e8).clone(), V(1), true, t);
    for (; t < 4; t += 0.1) tr.record(p.addScaledVector(V(0, 1), 1e8).clone(), V(0, 1), true, t);
    const pts = drawn(tr, t);
    // the tail is still out along the first leg (y = 0), not swung onto the new course
    expect(pts[pts.length - 1].p.y).toBeCloseTo(0, -3);
    expect(pts[0].p.y).toBeGreaterThan(1e9);
  });

  it('stays where it was laid after drop-out, and fades away with age', () => {
    const tr = new FtlTrail();
    for (let i = 0; i <= 20; i++) tr.record(V(1e8 * i), V(1), true, i * 0.1);
    tr.record(V(2.05e9), V(1), false, 2.05);
    const after = drawn(tr, 2.1);
    expect(after[0].p.x).toBeCloseTo(2.05e9, -6); // ends where it dropped out
    const later = drawn(tr, 2.05 + TRAIL_S / 2);
    expect(later[0].fade).toBeLessThan(0.6);
    tr.record(V(2.05e9), V(1), false, 3 + TRAIL_S);
    expect(drawn(tr, 3 + TRAIL_S).length).toBe(0); // gone
  });

  it('is cut by time only, however fast the ship went (SPACE-75)', () => {
    const tr = new FtlTrail();
    const v = 3e11; // m/s: 20 s of it is ~40 AU
    for (let i = 0; i <= 200; i++) tr.record(V(v * i * 0.1), V(1), true, i * 0.1);
    const pts = drawn(tr, 20);
    // the tail is still where the drive started, 20 s back: no length cap dragging it along
    expect(pts[pts.length - 1].p.x).toBeCloseTo(0, -6);
    expect(pts[pts.length - 1].fade).toBeGreaterThan(0.3);
  });

  it('tells when it has all aged out', () => {
    const tr = new FtlTrail();
    for (let i = 0; i <= 10; i++) tr.record(V(1e8 * i), V(1), true, i * 0.1);
    tr.record(V(1e9), V(1), false, 1.1);
    expect(tr.empty).toBe(false);
    tr.record(V(1e9), V(1), false, 2 + TRAIL_S);
    expect(tr.empty).toBe(true);
  });
});
