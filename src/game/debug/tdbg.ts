/**
 * The terrain pixel bisect (docs/perf.md): `bits` switch parts of the ground's pixel shader off
 * (planet.wgsl fs `dbg`), from `?tdbg=<bits>` in the URL or a sweep. Shift+` sweeps them all from
 * where you are, holding the resolution still, and prints the terrain pass's time for each.
 */
import type { PerfMonitor } from './Perf';
import type { DynamicResolution } from '../gpu/dynres';

export const terrainDebug = {
  bits: typeof location === 'undefined' ? 0 : Number(new URLSearchParams(location.search).get('tdbg')) || 0,
};

/** In order: the baseline, the floor, the first eight parts, each part, the colour noise's three, all, the baseline again (drift). */
const SWEEP = [0, 1024, 255, 1, 2, 4, 8, 16, 32, 64, 128, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 255 + 16384 + 32768 + 65536 + 131072 + 262144, 0];
const SETTLE_MS = 1000; // after a change: results in flight are the last setting's
const MEASURE_MS = 3000;

const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export class TerrainSweep {
  private step = 0;
  private since = 0;
  private terr: number[] = [];
  private gpu: number[] = [];
  private readonly rows: { tdbg: number; terrain: number; mean: number; gpu: number; n: number }[] = [];
  private readonly was = terrainDebug.bits;
  done = false;

  constructor(
    private readonly perf: PerfMonitor,
    private readonly dynres: DynamicResolution,
  ) {
    if (!perf.visible) perf.toggle();
    dynres.hold = true;
    this.set(0);
  }

  private set(i: number) {
    this.step = i;
    terrainDebug.bits = SWEEP[i];
    this.since = performance.now();
    this.terr = [];
    this.gpu = [];
  }

  /** Each frame's GPU times by pass, as they're read back. */
  sample(parts: [string, number][]) {
    if (this.done) return;
    const t = performance.now() - this.since;
    if (t > SETTLE_MS) {
      let total = 0;
      let terr = 0;
      for (const [label, ms] of parts) {
        total += ms;
        if (label === 'terrain') terr += ms;
      }
      this.terr.push(terr);
      this.gpu.push(total);
    }
    this.perf.note = `terrain sweep ${this.step + 1}/${SWEEP.length}: tdbg ${SWEEP[this.step]}…  ${this.table()}`;
    if (t < SETTLE_MS + MEASURE_MS) return;
    this.rows.push({ tdbg: SWEEP[this.step], terrain: median(this.terr), mean: this.terr.reduce((a, b) => a + b, 0) / this.terr.length, gpu: median(this.gpu), n: this.terr.length });
    if (this.step + 1 < SWEEP.length) return this.set(this.step + 1);
    this.done = true;
    terrainDebug.bits = this.was;
    this.dynres.hold = false;
    this.perf.note = `terrain sweep (ms, median): ${this.table()}`;
    console.table(this.rows);
    console.log('terrain sweep\n' + this.rows.map((r) => `${r.tdbg}\t${r.terrain.toFixed(3)}\t${r.mean.toFixed(3)}\t${r.gpu.toFixed(3)}\t${r.n}`).join('\n'));
    (globalThis as { terrainSweep?: unknown }).terrainSweep = this.rows;
  }

  private table() {
    return this.rows.map((r) => `${r.tdbg} ${r.terrain.toFixed(2)}`).join(' · ');
  }
}
