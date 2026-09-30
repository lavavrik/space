/** Stages of a frame, timed on the CPU in this order. */
const STAGES = ['sim', 'render', 'overlay', 'hud'] as const;
type Stage = (typeof STAGES)[number];
const COLORS: Record<Stage, string> = { sim: '#7fdcff', render: '#ffa53a', overlay: '#73ffb2', hud: '#e6d3ff' };

const N = 240; // frames of history in the graph
const GRAPH_MS = 50; // graph height in ms
const STORE_KEY = 'farlight.perf';

/**
 * Performance overlay (backquote toggles; also `?perf` in the URL). Shows FPS, frame time
 * (average, 95th percentile, worst), CPU time per stage, GPU time when the adapter has WebGPU's
 * timestamp queries, and the renderer's own line (resolution, draws), plus a graph of the last 240
 * frames: stacked CPU stages, the rest of each frame in grey (waiting on the GPU or vsync), GPU time
 * as a cyan line, and 60 / 30 fps guides.
 *
 * While it's shown, GPU time is also split by pass (compute, sky, bodies, stations and ships,
 * transparent, post; gpu/timing.ts), so a slow frame shows where its GPU time went.
 */
export class PerfMonitor {
  visible: boolean;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly frameMs = new Float32Array(N);
  private readonly stageMs: Record<Stage, Float32Array> = { sim: new Float32Array(N), render: new Float32Array(N), overlay: new Float32Array(N), hud: new Float32Array(N) };
  private readonly gpuMs = new Float32Array(N).fill(NaN);
  private i = 0; // next slot
  private count = 0;
  private t = 0; // start of the current stage
  private drawIn = 0;
  /** GPU ms per pass per frame. */
  private readonly split = new Map<string, Float32Array>();
  /** Set by the renderer when it can time the GPU (gpu/timing.ts). */
  gpuTimed = false;
  /** The renderer's line for the panel (resolution, draws…). */
  info: () => string = () => '';

  constructor(
    host: HTMLElement,
    private readonly overlayCanvas: HTMLCanvasElement,
  ) {
    this.canvas.id = 'perf';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    let saved = false;
    try {
      saved = localStorage.getItem(STORE_KEY) === '1';
    } catch {
      // storage unavailable: start hidden
    }
    this.visible = saved || new URLSearchParams(location.search).has('perf');
    this.canvas.style.display = this.visible ? '' : 'none';
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = 330 * dpr;
    this.canvas.height = 165 * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toggle() {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? '' : 'none';
    try {
      localStorage.setItem(STORE_KEY, this.visible ? '1' : '0');
    } catch {
      // not remembered
    }
  }

  /** Call at the start of a frame with the time since the previous one. */
  frameStart(frameMs: number) {
    this.frameMs[this.i] = frameMs;
    this.t = performance.now();
  }

  /** End the current stage (they run in STAGES order). */
  mark(stage: Stage) {
    const now = performance.now();
    this.stageMs[stage][this.i] = now - this.t;
    this.t = now;
  }

  /** Whether GPU time is timed and split by pass this frame (only while shown). */
  get splitting() {
    return this.visible && this.gpuTimed;
  }

  /** This frame's slot, to report its GPU time to once it's read back. */
  get slot() {
    return this.i;
  }

  /** A frame's GPU time, by pass (read back a frame or two after it was drawn). */
  gpuResult(slot: number, parts: [string, number][]) {
    let total = 0;
    for (const [label, ms] of parts) {
      total += ms;
      let a = this.split.get(label);
      if (!a) this.split.set(label, (a = new Float32Array(N).fill(NaN)));
      a[slot] = (Number.isNaN(a[slot]) ? 0 : a[slot]) + ms;
    }
    this.gpuMs[slot] = total;
  }

  frameEnd() {
    this.i = (this.i + 1) % N;
    this.count = Math.min(N, this.count + 1);
    this.gpuMs[this.i] = NaN;
    for (const a of this.split.values()) a[this.i] = NaN;
    if (this.visible && --this.drawIn <= 0) {
      this.drawIn = 4; // redraw the panel every 4th frame; it's cheap but not free
      this.draw();
    }
  }

  private recent(arr: Float32Array, n: number) {
    const out: number[] = [];
    for (let k = 1; k <= Math.min(n, this.count); k++) {
      const v = arr[(this.i - k + N) % N];
      if (!Number.isNaN(v)) out.push(v);
    }
    return out;
  }

  private draw() {
    const { ctx } = this;
    const W = 330,
      H = 165,
      gh = 70,
      gy = H - gh - 6;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,6,4,.82)';
    ctx.fillRect(0, 0, W, H);

    const f = this.recent(this.frameMs, 60);
    const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    const sorted = [...f].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const worst = sorted[sorted.length - 1] ?? 0;
    const mean = (a: Float32Array) => {
      const r = this.recent(a, 60);
      return r.length ? r.reduce((x, y) => x + y, 0) / r.length : NaN;
    };
    const gpu = mean(this.gpuMs);

    ctx.font = '11px "Chakra Petch", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffe6c7';
    ctx.fillText(`${(1000 / Math.max(avg, 0.01)).toFixed(0)} FPS   ${avg.toFixed(1)} ms   p95 ${p95.toFixed(1)}   max ${worst.toFixed(1)}`, 8, 6);
    let x = 8;
    for (const s of STAGES) {
      ctx.fillStyle = COLORS[s];
      const txt = `${s} ${mean(this.stageMs[s]).toFixed(1)}`;
      ctx.fillText(txt, x, 21);
      x += ctx.measureText(txt).width + 12;
    }
    ctx.fillStyle = '#7fdcff';
    ctx.fillText(Number.isNaN(gpu) ? 'gpu n/a' : `gpu ${gpu.toFixed(1)}`, x, 21);
    ctx.fillStyle = 'rgba(255,230,199,.7)';
    ctx.fillText(`${this.info()}  2D ${this.overlayCanvas.width}×${this.overlayCanvas.height}`, 8, 36);
    // GPU time by category, most first
    const parts = [...this.split].map(([k, a]): [string, number] => [k, mean(a)]).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]);
    ctx.fillStyle = '#7fdcff';
    ctx.fillText(parts.length ? 'gpu: ' + parts.slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ') : '', 8, 66);

    // graph: one column per frame, newest on the right
    const bw = (W - 16) / N;
    const y = (ms: number) => gy + gh - (Math.min(ms, GRAPH_MS) / GRAPH_MS) * gh;
    for (let k = 0; k < this.count; k++) {
      const slot = (this.i - this.count + k + N) % N;
      const bx = 8 + (N - this.count + k) * bw;
      let acc = 0;
      for (const s of STAGES) {
        const v = this.stageMs[s][slot];
        ctx.fillStyle = COLORS[s];
        ctx.fillRect(bx, y(acc + v), Math.max(1, bw), y(acc) - y(acc + v));
        acc += v;
      }
      const rest = this.frameMs[slot] - acc;
      if (rest > 0) {
        ctx.fillStyle = 'rgba(255,230,199,.18)';
        ctx.fillRect(bx, y(acc + rest), Math.max(1, bw), y(acc) - y(acc + rest));
      }
      const g = this.gpuMs[slot];
      if (!Number.isNaN(g)) {
        ctx.fillStyle = '#7fdcff';
        ctx.fillRect(bx, y(g) - 1, Math.max(1, bw), 2);
      }
    }
    ctx.strokeStyle = 'rgba(255,165,58,.35)';
    ctx.setLineDash([3, 3]);
    for (const ms of [16.7, 33.3]) {
      ctx.beginPath();
      ctx.moveTo(8, y(ms));
      ctx.lineTo(W - 8, y(ms));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,165,58,.6)';
    ctx.fillText('60', W - 22, y(16.7) - 12);
    ctx.fillText('30', W - 22, y(33.3) - 12);
  }

  dispose() {
    this.canvas.remove();
  }
}
