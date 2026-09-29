import type { THREE } from '../lib/three';

/** Stages of a frame, timed on the CPU in this order. */
const STAGES = ['sim', 'render', 'overlay', 'hud'] as const;
type Stage = (typeof STAGES)[number];
const COLORS: Record<Stage, string> = { sim: '#7fdcff', render: '#ffa53a', overlay: '#73ffb2', hud: '#e6d3ff' };

const N = 240; // frames of history in the graph
const GRAPH_MS = 50; // graph height in ms
const STORE_KEY = 'farlight.perf';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * Performance overlay (backquote toggles; also `?perf` in the URL). Shows FPS, frame time
 * (average, 95th percentile, worst), CPU time per stage, GPU time when the browser exposes
 * EXT_disjoint_timer_query_webgl2, draw calls, and render resolution, plus a graph of the last
 * 240 frames: stacked CPU stages, the rest of each frame in grey (waiting on the GPU or vsync),
 * GPU time as a cyan line, and 60 / 30 fps guides.
 *
 * While it's shown, GPU time is also split by what's drawn: the renderer tags each draw with a
 * category (terrain, planet, air, clouds, sky, post…; SceneRenderer.perfTag) and every change of
 * category starts a new timer query (gpuSegment), so a slow frame shows where its GPU time went.
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
  private readonly gl2: WebGL2RenderingContext | null;
  private readonly timer: TimerExt | null;
  private readonly queries: { q: WebGLQuery; slot: number; label: string | null }[] = [];
  private active: WebGLQuery | null = null;
  /** The category being timed (split timing), and GPU ms per category per frame. */
  private activeLabel: string | null = null;
  private readonly split = new Map<string, Float32Array>();

  constructor(
    host: HTMLElement,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly overlayCanvas: HTMLCanvasElement,
  ) {
    this.canvas.id = 'perf';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const ctx = renderer.getContext();
    this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext ? ctx : null;
    this.timer = this.gl2 ? (this.gl2.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
    // several gl.render calls per frame (sky, scene): count them all, reset once per frame
    renderer.info.autoReset = false;
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
    this.renderer.info.reset();
    this.pollGpu();
    this.t = performance.now();
  }

  /** End the current stage (they run in STAGES order). */
  mark(stage: Stage) {
    const now = performance.now();
    this.stageMs[stage][this.i] = now - this.t;
    this.t = now;
  }

  /** Whether GPU time is split by category this frame (only while shown). */
  get splitting() {
    return this.visible && !!this.timer;
  }

  /** Bracket the GPU work of the frame (only when the timer extension exists). */
  gpuBegin() {
    if (!this.timer || !this.gl2 || this.active || this.queries.length > 600) return;
    if (this.splitting) {
      this.gpuSegment('other');
      return;
    }
    const q = this.gl2.createQuery();
    if (!q) return;
    this.gl2.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.activeLabel = null;
  }

  /** Split timing: what's drawn from here on counts toward `label` (until the next segment). */
  gpuSegment(label: string) {
    if (!this.timer || !this.gl2 || !this.splitting || label === this.activeLabel) return;
    if (this.active) this.endQuery();
    const q = this.gl2.createQuery();
    if (!q) return;
    this.gl2.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.activeLabel = label;
  }

  gpuEnd() {
    if (this.active) this.endQuery();
  }

  private endQuery() {
    this.gl2!.endQuery(this.timer!.TIME_ELAPSED_EXT);
    this.queries.push({ q: this.active!, slot: this.i, label: this.activeLabel });
    this.active = null;
    this.activeLabel = null;
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

  private pollGpu() {
    const gl = this.gl2,
      ext = this.timer;
    if (!gl || !ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.queries.length) {
      const { q, slot, label } = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        const add = (a: Float32Array) => (a[slot] = (Number.isNaN(a[slot]) ? 0 : a[slot]) + ms);
        if (label === null) this.gpuMs[slot] = ms;
        else {
          add(this.gpuMs);
          let a = this.split.get(label);
          if (!a) this.split.set(label, (a = new Float32Array(N).fill(NaN)));
          add(a);
        }
      }
      gl.deleteQuery(q);
      this.queries.shift();
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
    const info = this.renderer.info;
    const db = this.renderer.getContext();

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
    ctx.fillText(
      `${db.drawingBufferWidth}×${db.drawingBufferHeight} @${this.renderer.getPixelRatio().toFixed(2)}  2D ${this.overlayCanvas.width}×${this.overlayCanvas.height}  ${info.render.calls} calls  ${(info.render.triangles / 1000).toFixed(0)}k tris`,
      8,
      36,
    );
    ctx.fillText(`${info.render.points} points  ${info.render.lines} lines  geo ${info.memory.geometries}  tex ${info.memory.textures}`, 8, 51);
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
