/**
 * Dynamic resolution (docs/perf.md): the 3D scene is rendered at a share of the canvas's resolution
 * (`scale`, of the width and the height) that keeps up with the display, and the final pass scales
 * it up to the canvas (the HUD is on its own canvas, always sharp).
 *
 * Judged by frame pacing, not by GPU timings: the passes' timestamps (gpu/timing.ts) overlap on a
 * tiled GPU (Apple's), their sum was 21 ms at a steady 120 fps. So:
 *
 *   - the refresh interval is the shortest the frames have come lately (5th percentile over ~10 s):
 *     a display's vsync, or, if even the lowest scale can't reach it, what's reachable (so it
 *     settles at, say, 60 fps rather than sitting at the lowest scale for nothing);
 *   - late frames (over 1.5 intervals), a quarter or more of them over half a second, while the CPU
 *     had room for its part: a step down (two if most were late);
 *   - none late for a while: a step up, to see. If that brings late frames within UP_TEST s, it's
 *     stepped back and the next try waits twice as long (up to 15 s: at a minute, after a heavy
 *     stretch it stayed at half resolution long after the scene got cheap again; frame intervals
 *     can't say there's room to spare, vsync holds them at the refresh).
 *
 * Each change remakes the render targets (GpuRenderer.setScale), so it doesn't hunt.
 */

/** The scale goes no lower than this, in steps of SCALE_STEP. */
export const MIN_SCALE = 0.5,
  SCALE_STEP = 0.05;
/** Judged every this often (s). */
const EVAL = 0.5;
/** A frame this many intervals long was late; this share of late frames is a step down. */
const LATE = 1.5,
  TOO_LATE = 0.25;
/** The CPU's own time must be under this share of the interval for the GPU to be the one to blame. */
const CPU_ROOM = 0.7;
/** Waiting to step up (s): at first, and at most after failed tries. A step up that's late within UP_TEST s failed. */
const UP_WAIT = 3,
  UP_WAIT_MAX = 15,
  UP_TEST = 3;

export class DynamicResolution {
  scale = 1;
  /** Off: always the full resolution (?fullres in the URL, or the Settings panel). */
  private readonly allowed = typeof location === 'undefined' || !new URLSearchParams(location.search).has('fullres');
  on = this.allowed;
  /** Held at the current scale (a measurement under way, debug/tdbg.ts). */
  hold = false;
  /** Settings: switch it (the URL's ?fullres still wins). */
  enable(on: boolean) {
    this.on = this.allowed && on;
    if (!this.on) this.scale = 1;
  }
  private readonly long: number[] = [];
  private win: number[] = [];
  private cpu: number[] = [];
  private last = 0;
  private evalAt = 0;
  private calmSince = 0;
  private upWait = UP_WAIT;
  private upAt = -Infinity;

  /** The display's refresh interval as estimated (ms). */
  get refresh() {
    if (this.long.length < 30) return 1000 / 60;
    const s = [...this.long].sort((a, b) => a - b);
    return Math.min(Math.max(s[Math.floor(s.length * 0.05)], 1000 / 240), 1000 / 30);
  }

  /**
   * At the end of each frame: the time it started (ms, the frame's rAF time) and how long the CPU
   * took over it (ms). Returns the new scale when it should change (null: keep it).
   */
  frame(now: number, cpuMs: number): number | null {
    const dt = now - this.last;
    this.last = now;
    if (!this.on || this.hold || dt <= 0 || dt > 200) return null; // (the first frame, or back from a hidden tab)
    this.long.push(dt);
    if (this.long.length > 1200) this.long.shift();
    this.win.push(dt);
    this.cpu.push(cpuMs);
    if (!this.evalAt) this.evalAt = now;
    if (now - this.evalAt < EVAL * 1000) return null;
    this.evalAt = now;
    const iv = this.refresh;
    const late = this.win.filter((v) => v > iv * LATE).length / this.win.length;
    const cpu = this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length;
    this.win = [];
    this.cpu = [];
    let next = this.scale;
    if (late >= TOO_LATE && cpu < iv * CPU_ROOM) {
      next = this.scale - SCALE_STEP * (late > 0.6 ? 2 : 1);
      // a step up that didn't hold: wait longer before the next try
      if (now - this.upAt < UP_TEST * 1000) this.upWait = Math.min(UP_WAIT_MAX, this.upWait * 2);
      this.calmSince = now;
    } else if (late > 0.02) this.calmSince = now;
    else if (this.scale < 1 && now - this.calmSince > this.upWait * 1000) {
      next = this.scale + SCALE_STEP;
      this.upAt = now;
      this.calmSince = now;
    }
    // a long stretch with no trouble: patience back to the start
    if (now - this.upAt > UP_WAIT_MAX * 2000) this.upWait = UP_WAIT;
    next = Math.min(1, Math.max(MIN_SCALE, Math.round(next / SCALE_STEP) * SCALE_STEP));
    if (Math.abs(next - this.scale) < 1e-6) return null;
    this.scale = next;
    return next;
  }
}
