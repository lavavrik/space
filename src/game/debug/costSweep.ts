/**
 * The scene's GPU cost by part (docs/perf.md), measured by switching parts off. Alt+` starts it:
 * each part (the sky, the terrain, the stations, the atmospheres…) is left out of the frame for a
 * couple of seconds in turn, and its cost is how much the frame's GPU time falls without it. A
 * baseline with everything on is measured every few parts, and each part is compared with the
 * baselines either side of it (interpolated in time), so a slow drift (the ship moving, the GPU's
 * clocks) doesn't read as a cost. The resolution is held still meanwhile.
 *
 * Why not time each part as its own pass: on a tile-based GPU (Apple's) a pass's timestamps take in
 * the reload and store of the 4× MSAA frame between passes and the last heavy pass's work spilling
 * past its end, so an empty pass read several ms (SPACE-94: a "stations, ships" pass drawing
 * nothing read the same as drawing them). The difference of whole frames has neither problem.
 *
 * What it switches off is `gpuSkip`, which the renderer's draws read (gpu/GpuRenderer.ts,
 * gpu/worlds.ts). The picture is wrong while it runs: only for measuring.
 */
import type { PerfMonitor } from './Perf';
import type { DynamicResolution } from '../gpu/dynres';

/** Parts of the scene left out of the frame while their name is in it. */
export const gpuSkip = new Set<string>();
// (in the console in dev builds, for A/B tests: farlightSkip.add('terrain'). A test page importing this
// module itself can get another copy of it once the dev server has hot-reloaded it, under a new URL,
// and switching parts off in that one does nothing: an A/B against it read every part as free)
if (import.meta.env.DEV) (globalThis as { farlightSkip?: Set<string> }).farlightSkip = gpuSkip;

/**
 * The parts, in the order they're measured: the scene's, then whole stages of the frame (the shadow
 * map, the volumetric clouds' march and composite, bloom). What's left (the tone map, the MSAA
 * resolve, the passes' fixed costs) shows as the rest: the frame's span less the parts' costs.
 */
export const SWEEP_PARTS = ['sky', 'far bodies', 'terrain', 'rocks', 'stations', 'ships', 'swarm', 'star glows', 'rings', 'dots', 'particles', 'atmospheres', 'cloud decks', 'shadow map', 'volumetric clouds', 'bloom'] as const;
/** A baseline (everything on) after this many parts. */
const BASE_EVERY = 4;
const SETTLE_MS = 600; // after a change: results in flight are the last setting's
const MEASURE_MS = 1500;

const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** One measured setting: a part off, or the baseline (null), its median GPU ms per frame and when (ms). */
interface Sample {
  part: string | null;
  gpu: number;
  t: number;
}

export interface PartCost {
  part: string;
  /** GPU ms per frame it costs (the baseline less the frame without it). */
  ms: number;
}

export class CostSweep {
  private readonly plan: (string | null)[] = [];
  private step = 0;
  private since = 0;
  private frames: number[] = [];
  private readonly samples: Sample[] = [];
  done = false;

  constructor(
    private readonly perf: PerfMonitor,
    private readonly dynres: DynamicResolution,
  ) {
    if (!perf.visible) perf.toggle();
    perf.costs = null;
    // baseline, four parts, baseline, …, baseline
    SWEEP_PARTS.forEach((p, i) => {
      if (i % BASE_EVERY === 0) this.plan.push(null);
      this.plan.push(p);
    });
    this.plan.push(null);
    dynres.hold = true;
    this.set(0);
  }

  private set(i: number) {
    this.step = i;
    gpuSkip.clear();
    const p = this.plan[i];
    if (p) gpuSkip.add(p);
    this.since = performance.now();
    this.frames = [];
  }

  /** Each frame's GPU time (its span, gpu/timing.ts: not the sum of its passes, which overlap), as it's read back. */
  sample(span: number) {
    if (this.done) return;
    const t = performance.now() - this.since;
    if (t > SETTLE_MS && span > 0) this.frames.push(span);
    const p = this.plan[this.step];
    this.perf.note = `cost sweep ${this.step + 1}/${this.plan.length}: ${p ? `${p} off` : 'everything on'} (the picture is wrong while it runs)`;
    if (t < SETTLE_MS + MEASURE_MS) return;
    this.samples.push({ part: p, gpu: median(this.frames), t: performance.now() });
    if (this.step + 1 < this.plan.length) return this.set(this.step + 1);
    this.finish();
  }

  /** Stop where it is (the overlay closed), with nothing reported. */
  cancel() {
    this.done = true;
    gpuSkip.clear();
    this.dynres.hold = false;
    this.perf.note = '';
  }

  private finish() {
    this.done = true;
    gpuSkip.clear();
    this.dynres.hold = false;
    const costs = costsOf(this.samples);
    // how much the baselines themselves varied: a cost no bigger than that is noise
    const base = this.samples.filter((s) => s.part === null).map((s) => s.gpu);
    this.perf.note = '';
    this.perf.costs = costs;
    this.perf.costNoise = base.length > 1 ? Math.max(...base) - Math.min(...base) : NaN;
    // the frame's span with everything on, for the rest (what no part accounts for)
    this.perf.costFrame = median(base);
    console.table(costs.map((c) => ({ part: c.part, ms: +c.ms.toFixed(3) })));
    (globalThis as { costSweep?: unknown }).costSweep = { costs, samples: this.samples };
  }
}

/**
 * Each part's cost from the samples: the baseline at its time (interpolated between the baselines
 * before and after it) less its own frame time. Most first.
 */
export function costsOf(samples: Sample[]): PartCost[] {
  const base = samples.filter((s) => s.part === null);
  const at = (t: number) => {
    const before = [...base].reverse().find((b) => b.t <= t) ?? base[0];
    const after = base.find((b) => b.t >= t) ?? base[base.length - 1];
    if (!before || !after) return NaN;
    if (after.t === before.t) return before.gpu;
    return before.gpu + ((after.gpu - before.gpu) * (t - before.t)) / (after.t - before.t);
  };
  return samples
    .filter((s): s is Sample & { part: string } => s.part !== null)
    .map((s) => ({ part: s.part, ms: at(s.t) - s.gpu }))
    .sort((a, b) => b.ms - a.ms);
}
