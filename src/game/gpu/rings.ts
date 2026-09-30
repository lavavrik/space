/**
 * A planetary ring's rocks up close in WebGPU (docs/webgpu.md phase 4; the WebGL twin and the why
 * are in render/RingField.ts and docs/rings.md).
 *
 * The same layers and detail copies as WebGL, the same bin table per layer (filled on the CPU each
 * frame, in doubles), the same rocks. What's new: a compute pass per copy runs every candidate
 * (rocksCull.wgsl) and appends only the rocks that are there and in view to a list, counting them
 * into an indirect draw; the draw (rocks.wgsl) then runs the vertex shader for those alone. WebGL ran
 * the full rock vertex shader for every candidate, most of them empty, out of range or off screen.
 */
import { THREE } from '../lib/three';
import { FADE_ABOVE, MINED_MAX, type MinedRock, minedHere, sphereGeometry } from '../render/RingField';
import { DISC_FROM, RING_HALF_THICK, ROCK_LAYERS, type RockLayer, ringDensity } from '../sim/rings';
import { METAL_RICH } from '../sim/ringRocks';
import type { World } from '../types';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { ROCKS_CULL_WGSL, ROCKS_WGSL } from './shaders';

/** Bytes in rock.wgsl Layer: 6 vec4, 20 floats, 24 + 6 vec4. */
const LAYER_BYTES = (6 * 4 + 20 + 24 * 4 + 6 * 4) * 4;
/** Bytes per listed rock or speck (rocksCull.wgsl Rock, Speck). */
const ITEM_BYTES = 32;

/** The ring and camera as the layers need them this frame. */
interface RingFrame {
  b: World;
  e1: THREE.Vector3; // in-plane axes turned so the camera is at angle 0
  e2: THREE.Vector3;
  n: THREE.Vector3;
  r: number; // camera's distance from the axis (m)
  h: number; // camera's height above the plane (m)
  thC: number; // camera's angle round the ring in the ring's fixed axes (rad)
  t: number;
  pxPerRad: number;
  light: THREE.Vector3;
  pc: THREE.Vector3;
}

interface Pipes {
  cullMesh: GPUComputePipeline;
  cullSpeck: GPUComputePipeline;
  mesh: GPURenderPipeline;
  speck: GPURenderPipeline;
  cullLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
  noise: GPUTextureView;
  noiseSamp: GPUSampler;
}

/** One copy of a layer (see RingField.ts): its bins, candidates, list and indirect draw. */
class LayerGpu {
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly u = new Float32Array(LAYER_BYTES / 4);
  private readonly uni: GPUBuffer;
  private readonly bins: GPUBuffer;
  private readonly list: GPUBuffer;
  private readonly args: GPUBuffer;
  private readonly cullGroup: GPUBindGroup;
  private readonly drawGroup: GPUBindGroup;
  private readonly count: number;
  private readonly mesh: { pos: GPUBuffer; idx: GPUBuffer; n: number } | null;
  visible = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly p: Pipes,
    private readonly L: RockLayer,
    private readonly seedK: number,
    lod: { detail: number; from: number; to: number },
  ) {
    const G = L.grid;
    this.data = new Float32Array(G * 3 * 4);
    const cell = (2 * L.range) / G;
    // a nearer copy covers just enough central cells to reach its cut (and a cell to spare)
    const window = lod.to < 1e29 ? Math.min(G, 2 * Math.ceil(lod.to / cell) + 2) : G;
    this.count = window * window * L.perCell;
    const isMesh = L.detail >= 0;
    const u = this.u;
    u[3] = L.perCell;
    u[7] = cell;
    u[11] = RING_HALF_THICK;
    u[24] = L.inner;
    u[25] = L.fadeTo;
    u[26] = L.range;
    u[27] = isMesh ? 0.5 : 0.85; // meshes shrink away over the outer half of their range
    u[30] = L.minR;
    u[31] = L.maxR;
    u[32] = lod.from;
    u[33] = lod.to;
    u[36] = G;
    u[37] = window;
    u[38] = this.count;
    u[39] = lod.detail >= 1 ? 1 : 0; // normals from the shape itself (not for the tiny far ones)
    u[40] = this.count; // (the list holds every candidate: it can't overflow)
    u[41] = METAL_RICH;
    this.uni = device.createBuffer({ label: 'rock layer', size: LAYER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bins = device.createBuffer({ label: 'rock bins', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.list = device.createBuffer({ label: 'rock list', size: this.count * ITEM_BYTES, usage: GPUBufferUsage.STORAGE });
    this.args = device.createBuffer({ label: 'rock draw', size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (isMesh) {
      const g = sphereGeometry(lod.detail);
      const pos = g.attributes.position.array as Float32Array;
      const idx = new Uint16Array(g.index!.array);
      g.dispose();
      const pb = device.createBuffer({ size: pos.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(pb, 0, pos.buffer, pos.byteOffset, pos.byteLength);
      const ib = device.createBuffer({ size: Math.ceil(idx.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ib, 0, idx.buffer, idx.byteOffset, Math.ceil(idx.byteLength / 4) * 4);
      this.mesh = { pos: pb, idx: ib, n: idx.length };
    } else this.mesh = null;
    this.cullGroup = device.createBindGroup({
      layout: p.cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uni } },
        { binding: 1, resource: { buffer: this.bins } },
        { binding: 2, resource: { buffer: this.list } },
        { binding: 3, resource: { buffer: this.args } },
      ],
    });
    this.drawGroup = device.createBindGroup({
      layout: p.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uni } },
        { binding: 1, resource: { buffer: this.list } },
        { binding: 2, resource: p.noise },
        { binding: 3, resource: p.noiseSamp },
      ],
    });
  }

  /** Fill the bin table and uniforms for this frame (as RingField.ts Layer.update); false if no part of it is near the ring. */
  update(fr: RingFrame, seed: number, mined: MinedRock[]) {
    const { b, r, h } = fr;
    const L = this.L,
      G = L.grid,
      cell = (2 * L.range) / G,
      R = b.radius;
    const i0 = Math.floor(r / cell);
    let any = false;
    for (let bi = 0; bi < G; bi++) {
      const gi = i0 - G / 2 + bi;
      const rb = (gi + 0.5) * cell;
      const dR = rb - r;
      let dens = 0;
      if (Math.abs(dR) < L.range && Math.abs(h) < L.range + RING_HALF_THICK && rb > 0) dens = ringDensity(b, rb / R) / 0.85;
      const o = bi * 4,
        o2 = (G + bi) * 4,
        o3 = (2 * G + bi) * 4;
      this.data[o + 2] = dens;
      if (dens <= 0) continue;
      any = true;
      // the camera's place in this bin's co-orbiting frame (double precision here)
      const w = Math.sqrt(b.mu / (rb * rb * rb));
      const nth = Math.max(1, Math.round((2 * Math.PI * rb) / cell)); // a whole number of cells round
      const dth = (2 * Math.PI) / nth;
      const phiC = (fr.thC - ((w * fr.t) % (2 * Math.PI))) / dth;
      const jc = Math.floor(phiC);
      this.data[o] = dR;
      this.data[o + 1] = phiC - jc;
      this.data[o + 3] = dth;
      const jm = ((jc % nth) + nth) % nth;
      this.data[o2] = gi;
      this.data[o2 + 1] = Math.floor(jm / 4096);
      this.data[o2 + 2] = jm % 4096;
      this.data[o3] = Math.floor(nth / 4096);
      this.data[o3 + 1] = nth % 4096;
    }
    this.visible = any;
    if (!any) return;
    const { device } = this;
    device.queue.writeBuffer(this.bins, 0, this.data);
    // the mined rocks of this layer near the camera (the nearest MINED_MAX, by bin and cell)
    const near: [number, MinedRock][] = [];
    for (const m of mined) {
      if (m.layer !== this.seedK) continue;
      const bi = m.gi - (i0 - G / 2);
      if (bi < 0 || bi >= G) continue;
      const o2 = (G + bi) * 4,
        o3 = (2 * G + bi) * 4;
      const nth = this.data[o3] * 4096 + this.data[o3 + 1],
        jm = this.data[o2 + 1] * 4096 + this.data[o2 + 2];
      if (this.data[bi * 4 + 2] <= 0 || nth <= 0) continue;
      let dj = Math.abs(m.jj - jm) % nth;
      dj = Math.min(dj, nth - dj);
      if (dj > G / 2) continue;
      near.push([Math.abs(bi - G / 2) + dj, m]);
    }
    near.sort((a, c) => a[0] - c[0]);
    const n = Math.min(MINED_MAX, near.length);
    const u = this.u;
    for (let k = 0; k < n; k++) {
      const m = near[k][1];
      u.set([m.gi, Math.floor(m.jj / 4096), m.jj % 4096, m.q], 44 + k * 4);
      u[44 + MINED_MAX * 4 + k] = m.left;
    }
    u[35] = n;
    u.set([fr.e1.x, fr.e1.y, fr.e1.z], 0);
    u.set([fr.e2.x, fr.e2.y, fr.e2.z], 4);
    u.set([fr.n.x, fr.n.y, fr.n.z], 8);
    const c = b.ring!.color;
    u.set([c.r, c.g, c.b, seed + this.seedK * 7919], 12);
    u.set([fr.light.x, fr.light.y, fr.light.z, R], 16);
    u.set([fr.pc.x, fr.pc.y, fr.pc.z, b.albedo], 20);
    u[28] = r;
    u[29] = h;
    u[34] = fr.pxPerRad;
    device.queue.writeBuffer(this.uni, 0, u);
    // the indirect draw, its instance count reset for the cull to count up
    const args = this.mesh ? new Uint32Array([this.mesh.n, 0, 0, 0, 0]) : new Uint32Array([6, 0, 0, 0, 0]);
    device.queue.writeBuffer(this.args, 0, args);
  }

  cull(pass: GPUComputePassEncoder) {
    pass.setPipeline(this.mesh ? this.p.cullMesh : this.p.cullSpeck);
    pass.setBindGroup(1, this.cullGroup);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setBindGroup(1, this.drawGroup);
    if (this.mesh) {
      pass.setPipeline(this.p.mesh);
      pass.setVertexBuffer(0, this.mesh.pos);
      pass.setIndexBuffer(this.mesh.idx, 'uint16');
      pass.drawIndexedIndirect(this.args, 0);
    } else {
      pass.setPipeline(this.p.speck);
      pass.drawIndirect(this.args, 0);
    }
  }

  dispose() {
    this.uni.destroy();
    this.bins.destroy();
    this.list.destroy();
    this.args.destroy();
    this.mesh?.pos.destroy();
    this.mesh?.idx.destroy();
  }
}

const X = new THREE.Vector3(1, 0, 0),
  Z = new THREE.Vector3(0, 0, 1);

export class RingFieldGpu {
  private readonly layers: LayerGpu[] = [];
  private active = false;
  /** How far the flat disc should fade out around the camera (m; 0 when there are no rocks here). */
  nearFade = 0;

  constructor(
    device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    noise: GPUTexture,
    noiseSamp: GPUSampler,
  ) {
    const CS = GPUShaderStage.COMPUTE,
      VS = GPUShaderStage.VERTEX,
      FS = GPUShaderStage.FRAGMENT;
    const cullLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: CS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: CS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: CS, buffer: { type: 'storage' } },
        { binding: 3, visibility: CS, buffer: { type: 'storage' } },
      ],
    });
    const drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VS | FS, texture: { viewDimension: '3d' } },
        { binding: 3, visibility: VS | FS, sampler: {} },
      ],
    });
    const cullMod = device.createShaderModule({ label: 'rocks cull', code: ROCKS_CULL_WGSL });
    const cullPL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, cullLayout] });
    const drawMod = device.createShaderModule({ label: 'rocks', code: ROCKS_WGSL });
    const drawPL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, drawLayout] });
    const depth: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' };
    const p: Pipes = {
      cullLayout,
      drawLayout,
      noise: noise.createView(),
      noiseSamp,
      cullMesh: device.createComputePipeline({ label: 'cull rocks', layout: cullPL, compute: { module: cullMod, entryPoint: 'cullMeshes' } }),
      cullSpeck: device.createComputePipeline({ label: 'cull specks', layout: cullPL, compute: { module: cullMod, entryPoint: 'cullSpecks' } }),
      mesh: device.createRenderPipeline({
        label: 'rocks',
        layout: drawPL,
        vertex: { module: drawMod, entryPoint: 'vsMesh', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
        fragment: { module: drawMod, entryPoint: 'fsMesh', targets: [{ format: HDR_FORMAT }] },
        primitive: { cullMode: 'back' },
        depthStencil: depth,
        multisample: { count: SAMPLES },
      }),
      speck: device.createRenderPipeline({
        label: 'specks',
        layout: drawPL,
        vertex: { module: drawMod, entryPoint: 'vsSpeck' },
        fragment: { module: drawMod, entryPoint: 'fsSpeck', targets: [{ format: HDR_FORMAT }] },
        depthStencil: depth,
        multisample: { count: SAMPLES },
      }),
    };
    ROCK_LAYERS.forEach((L, k) => {
      // one copy per detail level, each drawing its band of distance (nearest finest)
      let from = 0;
      for (const lv of L.lods ?? []) {
        this.layers.push(new LayerGpu(device, p, L, k, { detail: lv.detail, from, to: lv.cut }));
        from = lv.cut;
      }
      this.layers.push(new LayerGpu(device, p, L, k, { detail: L.detail, from, to: 1e30 }));
    });
  }

  /**
   * Show the rocks of `b`'s ring around the camera (as RingField.ts update): `rel` is the planet's
   * centre relative to the camera (m), `n` the ring's normal, `light` the direction to the star.
   * Returns whether any part of the ring is close enough to have rocks.
   */
  update(b: World, rel: THREE.Vector3, n: THREE.Vector3, light: THREE.Vector3, t: number, pxPerRad: number) {
    const ring = b.ring!;
    const R = b.radius;
    const far = ROCK_LAYERS[ROCK_LAYERS.length - 1].range;
    const cx = -rel.x,
      cy = -rel.y,
      cz = -rel.z;
    const h = cx * n.x + cy * n.y + cz * n.z;
    const px = cx - h * n.x,
      py = cy - h * n.y,
      pz = cz - h * n.z;
    const r = Math.hypot(px, py, pz);
    this.nearFade = 0;
    this.active = Math.abs(h) < far + RING_HALF_THICK && r > ring.inner * R - far && r < ring.outer * R + far;
    if (!this.active) return false;
    const above = Math.max(0, Math.abs(h) - RING_HALF_THICK);
    this.nearFade = DISC_FROM * Math.max(0, 1 - above / FADE_ABOVE);
    const e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Z).normalize();
    const e2 = new THREE.Vector3().crossVectors(n, e1);
    const thC = Math.atan2(px * e2.x + py * e2.y + pz * e2.z, px * e1.x + py * e1.y + pz * e1.z);
    const d1 = e1.clone().multiplyScalar(Math.cos(thC)).addScaledVector(e2, Math.sin(thC));
    const d2 = new THREE.Vector3().crossVectors(n, d1);
    const fr: RingFrame = { b, e1: d1, e2: d2, n, r, h, thC, t, pxPerRad, light, pc: rel.clone() };
    const seed = Math.floor(ring.seed * 1e4);
    const mined = minedHere(b);
    for (const l of this.layers) l.update(fr, seed, mined);
    return true;
  }

  /** Nothing to draw this frame (no ringed world near). */
  off() {
    this.active = false;
    this.nearFade = 0;
  }

  cull(enc: GPUCommandEncoder, frameGroup: GPUBindGroup) {
    if (!this.active) return;
    const pass = enc.beginComputePass({ label: 'cull rocks' });
    pass.setBindGroup(0, frameGroup);
    for (const l of this.layers) if (l.visible) l.cull(pass);
    pass.end();
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.active) return;
    for (const l of this.layers) if (l.visible) l.draw(pass);
  }

  dispose() {
    for (const l of this.layers) l.dispose();
  }
}

