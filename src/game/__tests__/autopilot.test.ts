import { describe, expect, it } from 'vitest';
import { approachSpeed, approachTime, DEFAULT_PROFILE } from '../sim/autopilot';

const RADIAL_CAP = DEFAULT_PROFILE.radialCap,
  PLANE_CAP = DEFAULT_PROFILE.planeCap;

/** Integrate the approach profile numerically: how long until the distance drops below `done`. */
function simulate(d: number, cap: number, done: number) {
  let t = 0;
  const dt = 0.01;
  while (d > done && t < 1e5) {
    d -= approachSpeed(d, cap) * dt;
    t += dt;
  }
  return t;
}

describe('autopilot approach profile', () => {
  it('predicts its own duration (the guide ETA) to within a few percent', () => {
    for (const [d, cap, done] of [[1e6, RADIAL_CAP, 1000], [2.2e6, RADIAL_CAP, 1000], [5e4, RADIAL_CAP, 1000], [8e5, PLANE_CAP, 1000], [3e3, RADIAL_CAP, 200]]) {
      const predicted = approachTime(d, cap, done),
        actual = simulate(d, cap, done);
      expect(Math.abs(predicted - actual) / actual).toBeLessThan(0.03);
    }
  });

  it('never exceeds its cap and slows to a stop at the target', () => {
    expect(approachSpeed(1e7, RADIAL_CAP)).toBe(RADIAL_CAP);
    expect(approachSpeed(1e7, PLANE_CAP)).toBe(PLANE_CAP);
    expect(approachSpeed(10, RADIAL_CAP)).toBeLessThan(5);
    expect(approachSpeed(0, RADIAL_CAP)).toBe(0);
  });

  it('closes 1,000 km in about five minutes (it used to take fifteen)', () => {
    expect(approachTime(1e6, RADIAL_CAP, 1000)).toBeLessThan(330);
  });
});
