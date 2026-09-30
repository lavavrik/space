/**
 * Planet terrain up close in WebGPU (docs/webgpu.md phase 3; the WebGL twin and the why are in
 * render/Terrain.ts and docs/terrain.md): a cube-sphere quadtree of 32 × 32 chunks, chosen by the
 * camera's distance, drawn by planet.wgsl vsChunk.
 *
 * What differs from WebGL: a chunk's heights, normals and sun shadows are baked by a compute shader
 * (terrainBake.wgsl) into a storage buffer the vertex shader reads, instead of a points pass into a
 * float texture; the index, grid and skirt buffers are the same for every chunk, so they're shared;
 * and each chunk's transform is written per frame (camera-relative, from doubles on the CPU).
 */
import { THREE } from '../lib/three';
import { faceDir, KEEP_FRAMES, MAX_BUILDS, MAX_REBAKES, MIN_SPACING, N, SKIRT_SPACINGS, SPLIT_K, SUN_REBAKE } from '../render/Terrain';
import { reliefAmp, T_OCT_MAX, terrainOffsets } from '../sim/terrain';
import type { World } from '../types';

/** Bytes in chunk.wgsl Chunk: mat4 + 4 floats + 2 × 17 vec4. */
export const CHUNK_BYTES = 64 + 16 + 2 * 17 * 16;
const V = (N + 1) * (N + 1); // grid vertices
const S = 4 * (N + 1); // skirt vertices, one per edge vertex
const BAKE_BYTES = V * 2 * 16;

interface Chunk {
  f: number;
  L: number;
  i: number;
  j: number;
  cen: THREE.Vector3; // centre (m, the world's frame)
  pos: GPUBuffer;
  dir: GPUBuffer;
  uni: GPUBuffer;
  bake: GPUBuffer;
  draw: GPUBindGroup;
  compute: GPUBindGroup;
  used: number;
  sun: THREE.Vector3; // the sun direction it was baked with (the world's frame)
}

/** What every world's terrain shares: the pipelines' layouts and the buffers alike in every chunk. */
export class TerrainShared {
  readonly grid: GPUBuffer;
  readonly skirt: GPUBuffer;
  readonly idx: GPUBuffer;
  readonly count: number;

  constructor(
    readonly device: GPUDevice,
    readonly drawLayout: GPUBindGroupLayout,
    readonly computeLayout: GPUBindGroupLayout,
    readonly bakePipe: GPUComputePipeline,
  ) {
    const grid = new Float32Array((V + S) * 2),
      skirt = new Float32Array(V + S);
    for (let y = 0; y <= N; y++)
      for (let x = 0; x <= N; x++) {
        grid[(y * (N + 1) + x) * 2] = x;
        grid[(y * (N + 1) + x) * 2 + 1] = y;
      }
    const idx: number[] = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = y * (N + 1) + x,
          b = a + 1,
          c = a + N + 1,
          e = c + 1;
        idx.push(a, b, e, a, e, c);
      }
    // skirts: each edge's vertices again (a skirt vertex reads its edge vertex's bake), joined to the
    // edge by a strip; the edges run counter-clockwise around the chunk, so the strips face out
    let sk = V;
    for (const e of edgeLoops()) {
      const first = sk;
      for (const v of e) {
        grid[sk * 2] = grid[v * 2];
        grid[sk * 2 + 1] = grid[v * 2 + 1];
        skirt[sk] = 1;
        sk++;
      }
      for (let q = 0; q < N; q++) idx.push(e[q], first + q + 1, e[q + 1], e[q], first + q, first + q + 1);
    }
    const buf = (data: ArrayBufferView<ArrayBuffer>, usage: number) => {
      const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    this.grid = buf(grid, GPUBufferUsage.VERTEX);
    this.skirt = buf(skirt, GPUBufferUsage.VERTEX);
    this.idx = buf(new Uint16Array(idx), GPUBufferUsage.INDEX);
    this.count = idx.length;
  }

  dispose() {
    this.grid.destroy();
    this.skirt.destroy();
    this.idx.destroy();
  }
}

/** The four edges' vertex indices, counter-clockwise around the chunk. */
function edgeLoops() {
  const edges: number[][] = [[], [], [], []];
  for (let q = 0; q <= N; q++) {
    edges[0].push(q); // bottom (y = 0), left to right
    edges[1].push(q * (N + 1) + N); // right (x = N), bottom to top
    edges[2].push(N * (N + 1) + (N - q)); // top (y = N), right to left
    edges[3].push((N - q) * (N + 1)); // left (x = 0), top to bottom
  }
  return edges;
}

export class TerrainGpu {
  private readonly chunks = new Map<string, Chunk>();
  private readonly R: number;
  private readonly A: number;
  private readonly off: Float32Array;
  private frame = 0;
  private builds = 0;
  private rebakes = 0;
  private readonly tmp: number[] = [0, 0, 0];
  private readonly sun = new THREE.Vector3(0, 1, 0);
  /** Chunks to draw this frame. */
  private shown: Chunk[] = [];
  /** Chunks to (re)bake this frame. */
  private toBake: Chunk[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly mc = new THREE.Matrix4();
  private readonly model = new Float32Array(16);

  constructor(
    b: World,
    private readonly sh: TerrainShared,
    private readonly worldGroup: GPUBindGroup,
  ) {
    this.R = b.radius;
    this.A = reliefAmp(b);
    this.off = terrainOffsets(b.seed);
  }

  /**
   * Pick the chunks for a camera at `cam` (m, the world's own frame) with the sun in direction `sun`
   * (same frame); queue new chunks and ones the sun has moved over for baking; place the chosen ones
   * for a world at `rel` (camera-relative) turned by `q`.
   */
  update(cam: THREE.Vector3, sun: THREE.Vector3, rel: THREE.Vector3, q: THREE.Quaternion) {
    this.frame++;
    this.builds = 0;
    this.rebakes = 0;
    this.shown = [];
    this.toBake = [];
    this.sun.copy(sun);
    const camDist = cam.length();
    const camDir = cam.clone().divideScalar(camDist);
    // the horizon, allowing for mountains: beyond it nothing is visible
    const horizon = Math.acos(Math.min(1, (this.R - this.A) / Math.max(camDist, this.R)));
    for (let f = 0; f < 6; f++) this.visit(f, 0, 0, 0, cam, camDir, horizon);
    for (const [k, c] of this.chunks)
      if (this.frame - c.used > KEEP_FRAMES) {
        this.free(c);
        this.chunks.delete(k);
      }
    // each chunk's transform: its centre turned into place, in doubles, then to float32
    this.m.compose(rel, q, new THREE.Vector3(1, 1, 1));
    for (const c of this.shown) {
      this.mc.makeTranslation(c.cen.x, c.cen.y, c.cen.z).premultiply(this.m);
      this.model.set(this.mc.elements);
      this.sh.device.queue.writeBuffer(c.uni, 0, this.model);
    }
  }

  private visit(f: number, L: number, i: number, j: number, cam: THREE.Vector3, camDir: THREE.Vector3, horizon: number) {
    const n = 2 ** L;
    const edge = (this.R * (Math.PI / 2)) / n;
    const c = faceDir(f, -1 + (2 * (i + 0.5)) / n, -1 + (2 * (j + 0.5)) / n, this.tmp);
    // beyond the horizon (with the chunk's own angular size): skip it and everything under it
    const ang = Math.acos(Math.max(-1, Math.min(1, c[0] * camDir.x + c[1] * camDir.y + c[2] * camDir.z)));
    if (ang - (edge / this.R) * 0.8 > horizon) return;
    const dist = Math.hypot(cam.x - c[0] * this.R, cam.y - c[1] * this.R, cam.z - c[2] * this.R);
    const canSplit = edge / N / 2 >= MIN_SPACING;
    if (canSplit && dist < SPLIT_K * edge) {
      // split, if all four children are ready (or can be built this frame); else draw this one
      const kids: [number, number][] = [
        [2 * i, 2 * j],
        [2 * i + 1, 2 * j],
        [2 * i, 2 * j + 1],
        [2 * i + 1, 2 * j + 1],
      ];
      const missing = kids.filter(([a, b2]) => !this.chunks.has(key(f, L + 1, a, b2))).length;
      if (this.builds + missing <= MAX_BUILDS) {
        for (const [a, b2] of kids) this.visit(f, L + 1, a, b2, cam, camDir, horizon);
        return;
      }
    }
    this.show(f, L, i, j);
  }

  private show(f: number, L: number, i: number, j: number) {
    const k = key(f, L, i, j);
    let c = this.chunks.get(k);
    if (!c) {
      this.builds++;
      c = this.build(f, L, i, j);
      this.chunks.set(k, c);
      this.toBake.push(c);
      c.sun.copy(this.sun);
    } else if (c.sun.dot(this.sun) < SUN_REBAKE && this.rebakes < MAX_REBAKES) {
      this.rebakes++;
      this.toBake.push(c);
      c.sun.copy(this.sun);
    }
    c.used = this.frame;
    this.shown.push(c);
  }

  /** The queued bakes (terrainBake.wgsl), before the frame's render pass. Group 0 is the frame's. */
  bake(enc: GPUCommandEncoder, frameGroup: GPUBindGroup) {
    if (!this.toBake.length) return;
    const pass = enc.beginComputePass({ label: 'terrain bake' });
    pass.setPipeline(this.sh.bakePipe);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, this.worldGroup);
    for (const c of this.toBake) {
      pass.setBindGroup(2, c.compute);
      pass.dispatchWorkgroups(Math.ceil(V / 64));
    }
    pass.end();
  }

  /** The chosen chunks, with the chunk pipeline and the world's group already set. */
  draw(pass: GPURenderPassEncoder) {
    const { sh } = this;
    pass.setVertexBuffer(2, sh.grid);
    pass.setVertexBuffer(3, sh.skirt);
    pass.setIndexBuffer(sh.idx, 'uint16');
    for (const c of this.shown) {
      pass.setBindGroup(2, c.draw);
      pass.setVertexBuffer(0, c.pos);
      pass.setVertexBuffer(1, c.dir);
      pass.drawIndexed(sh.count);
    }
  }

  get count() {
    return this.shown.length;
  }

  /**
   * The chunk centre's lattice point for each octave (terrain.wgsl terrQ): centre · 1.6 · 2.03^i +
   * offset, in double precision, wrapped by `period` for the texture octaves (8 for the noise, 2312
   * = 8 × 289 for the crater hash), as a vec4 array.
   */
  private latticeAt(c: number[], period: number, out: Float32Array, at: number) {
    let k = 1.6;
    for (let i = 0; i < T_OCT_MAX; i++) {
      for (let a = 0; a < 3; a++) {
        const v = c[a] * k + this.off[i * 3 + a];
        out[at + i * 4 + a] = i >= 3 ? v - Math.floor(v / period) * period : v;
      }
      k *= 2.03;
    }
  }

  private build(f: number, L: number, i: number, j: number): Chunk {
    const { device } = this.sh;
    const n = 2 ** L;
    const s0 = -1 + (2 * i) / n,
      t0 = -1 + (2 * j) / n,
      ds = 2 / n / N;
    const R = this.R;
    const d: number[] = [0, 0, 0];
    const cen = faceDir(f, s0 + ds * (N / 2), t0 + ds * (N / 2), [0, 0, 0]);
    const cx = cen[0] * R,
      cy = cen[1] * R,
      cz = cen[2] * R;
    const pos = new Float32Array((V + S) * 3),
      dir = new Float32Array((V + S) * 3);
    for (let y = 0; y <= N; y++)
      for (let x = 0; x <= N; x++) {
        const k = (y * (N + 1) + x) * 3;
        faceDir(f, s0 + ds * x, t0 + ds * y, d);
        pos[k] = d[0] * R - cx;
        pos[k + 1] = d[1] * R - cy;
        pos[k + 2] = d[2] * R - cz;
        dir[k] = d[0];
        dir[k + 1] = d[1];
        dir[k + 2] = d[2];
      }
    let sk = V;
    for (const e of edgeLoops())
      for (const v of e) {
        pos.copyWithin(sk * 3, v * 3, v * 3 + 3);
        dir.copyWithin(sk * 3, v * 3, v * 3 + 3);
        sk++;
      }
    const edge = (R * (Math.PI / 2)) / n,
      spacing = edge / N;
    // octaves the vertices can show: lattice cells at least ~3 vertex spacings across
    const vOct = Math.max(1, Math.min(17, Math.floor(Math.log(R / (1.6 * 3 * spacing)) / Math.log(2.03)) + 1));
    const u = new Float32Array(CHUNK_BYTES / 4);
    // (the model, at 0…15, is written per frame)
    u[16] = vOct;
    u[17] = spacing;
    // deep enough to cover the crack to a coarser neighbour, no deeper (render/Terrain.ts)
    u[18] = spacing * SKIRT_SPACINGS + this.A * 0.6 ** vOct;
    u[19] = N + 1;
    this.latticeAt(cen, 8, u, 20);
    this.latticeAt(cen, 2312, u, 20 + 17 * 4);
    const mk = (data: Float32Array<ArrayBuffer>, usage: number, label: string) => {
      const b = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const posB = mk(pos, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE, 'chunk pos');
    const dirB = mk(dir, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE, 'chunk dir');
    const uni = mk(u, GPUBufferUsage.UNIFORM, 'chunk');
    const bake = device.createBuffer({ label: 'chunk bake', size: BAKE_BYTES, usage: GPUBufferUsage.STORAGE });
    const draw = device.createBindGroup({
      layout: this.sh.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: bake } },
      ],
    });
    const compute = device.createBindGroup({
      layout: this.sh.computeLayout,
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: bake } },
        { binding: 2, resource: { buffer: posB } },
        { binding: 3, resource: { buffer: dirB } },
      ],
    });
    return { f, L, i, j, cen: new THREE.Vector3(cx, cy, cz), pos: posB, dir: dirB, uni, bake, draw, compute, used: 0, sun: new THREE.Vector3() };
  }

  private free(c: Chunk) {
    c.pos.destroy();
    c.dir.destroy();
    c.uni.destroy();
    c.bake.destroy();
  }

  dispose() {
    for (const c of this.chunks.values()) this.free(c);
    this.chunks.clear();
  }
}

const key = (f: number, L: number, i: number, j: number) => `${f}/${L}/${i}/${j}`;
