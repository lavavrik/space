import { describe, expect, it } from 'vitest';
import { DynamicResolution, MIN_SCALE } from '../gpu/dynres';

const VSYNC = 1000 / 120;

/**
 * Run `secs` of frames that each take `ms` (or `ms(scale)`), shown on a 120 Hz display (a frame
 * that misses a vsync waits for the next), the CPU taking `cpu` ms of each. Returns the time.
 */
function run(d: DynamicResolution, t0: number, secs: number, ms: number | ((scale: number) => number), cpu = 2) {
  let t = t0;
  while (t < t0 + secs * 1000) {
    const took = Math.max(typeof ms === 'number' ? ms : ms(d.scale), cpu);
    t += Math.ceil(took / VSYNC - 1e-9) * VSYNC;
    d.frame(t, cpu);
  }
  return t;
}

describe('dynamic resolution', () => {
  it('stays at full resolution while frames keep up', () => {
    const d = new DynamicResolution();
    run(d, 0, 20, 5);
    expect(d.scale).toBe(1);
  });

  it('steps down when the GPU makes frames late, and settles where they keep up', () => {
    const d = new DynamicResolution();
    let t = run(d, 0, 10, 5); // the display: 120 Hz
    // the GPU's time goes with the pixels: 14 ms at full resolution, a 120 Hz frame needs ≤ 8.3
    const gpu = (s: number) => 14 * s * s;
    t = run(d, t, 20, gpu);
    expect(d.scale).toBeLessThan(1);
    expect(14 * d.scale * d.scale).toBeLessThanOrEqual(VSYNC);
    expect(d.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    // and it doesn't hunt: over the next minute it stays within a step of where it settled
    const settled = d.scale;
    run(d, t, 60, gpu);
    expect(Math.abs(d.scale - settled)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("doesn't step down when it's the CPU that's slow", () => {
    const d = new DynamicResolution();
    const t = run(d, 0, 10, 5);
    run(d, t, 10, 15, 15);
    expect(d.scale).toBe(1);
  });

  it('steps back up once the load is gone', () => {
    const d = new DynamicResolution();
    let t = run(d, 0, 10, 5);
    t = run(d, t, 10, (s) => 20 * s * s);
    expect(d.scale).toBeLessThan(1);
    run(d, t, 60, 5);
    expect(d.scale).toBe(1);
  });
});
