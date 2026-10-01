/**
 * GPU particles and grain fields (docs/particles.md; particles.wgsl, fields.wgsl, sprite.wgsl).
 *
 * Particles: a ring of CAP in a storage buffer. The layers above call `emit` during their update;
 * then `compute` spawns this frame's (each emitter's share of new ones, with random spread) and
 * simulates all (age, drag, motion; camera-relative, velocities relative to the frame body), listing
 * the living for an indirect draw. Fields: up to 8 per frame, grains made up in the vertex stage.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { FIELDS_WGSL, PARTICLES_WGSL } from './shaders';

const CAP = 1 << 17; // 131072 particles
const PART_BYTES = 64;
const MAX_EMITTERS = 32;
const SIM_BYTES = 16 + 32 + MAX_EMITTERS * 96;
const MAX_FIELDS = 8;

export interface Emitter {
  pos: THREE.Vector3; // camera-relative
  vel: THREE.Vector3; // base velocity, relative to the frame body
  dir?: THREE.Vector3; // ejection direction (unit)
  speed?: number; // along it (m/s; each particle 0.5…1.5 ×)
  spread?: number; // random extra speed (m/s, any direction)
  region?: number; // spawned within this radius (m)
  count: number; // new particles this frame (fractions carry over per key)
  color: [number, number, number];
  size: number; // m
  life: number; // s
  lifeJitter?: number;
  growth?: number; // size × (1 + growth · age)
  drag?: number; // 1/s
  streak?: number; // s of motion drawn as a streak
  fadeIn?: number; // s
  key?: string; // carries fractional counts over from frame to frame
}

export interface Field {
  mode: 'wrap' | 'ball';
  /** wrap: the camera's place in the repeating space (m, doubles; wrapped here); ball: centre, camera-relative. */
  at: THREE.Vector3;
  size: number; // box or ball radius (m)
  count: number;
  seed: number;
  grain: number; // m, or negative: pixels
  color: [number, number, number];
  glint?: number;
  /** Each grain's own slow drift (m/s): the field lives even when you sit still. */
  drift?: number;
  /** Each grain drawn as a streak back to where it was a moment ago (camera-relative m): rain. */
  streak?: THREE.Vector3;
}

const blendAdd: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } };

export class Particles {
  private readonly simBuf: GPUBuffer;
  private readonly simData = new ArrayBuffer(SIM_BYTES);
  private readonly parts: GPUBuffer;
  private readonly alive: GPUBuffer;
  private readonly args: GPUBuffer;
  private readonly computeGroup: GPUBindGroup;
  private readonly drawGroup: GPUBindGroup;
  private readonly spawnPipe: GPUComputePipeline;
  private readonly simPipe: GPUComputePipeline;
  private readonly drawPipe: GPURenderPipeline;
  private readonly fieldBuf: GPUBuffer;
  private readonly fieldData = new Float32Array(MAX_FIELDS * 20);
  private readonly fieldGroup: GPUBindGroup;
  private readonly fieldPipe: GPURenderPipeline;
  private readonly drawOverPipe: GPURenderPipeline;
  private readonly fieldOverPipe: GPURenderPipeline;
  private readonly depthLayout: GPUBindGroupLayout;
  private depthGroup: GPUBindGroup | null = null;
  private emitters: Emitter[] = [];
  private fields: Field[] = [];
  private readonly carry = new Map<string, number>();
  private head = 0;
  private seed = 1;
  private live = false;

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const CS = GPUShaderStage.COMPUTE,
      VS = GPUShaderStage.VERTEX;
    this.simBuf = device.createBuffer({ label: 'particles sim', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.parts = device.createBuffer({ label: 'particles', size: CAP * PART_BYTES, usage: GPUBufferUsage.STORAGE });
    this.alive = device.createBuffer({ label: 'particles alive', size: CAP * 4, usage: GPUBufferUsage.STORAGE });
    this.args = device.createBuffer({ label: 'particles draw', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const computeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: CS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: CS, buffer: { type: 'storage' } },
        { binding: 2, visibility: CS, buffer: { type: 'storage' } },
        { binding: 3, visibility: CS, buffer: { type: 'storage' } },
      ],
    });
    const drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VS, buffer: { type: 'read-only-storage' } },
      ],
    });
    const buf = (b: GPUBuffer) => ({ buffer: b });
    this.computeGroup = device.createBindGroup({
      layout: computeLayout,
      entries: [
        { binding: 0, resource: buf(this.simBuf) },
        { binding: 1, resource: buf(this.parts) },
        { binding: 2, resource: buf(this.alive) },
        { binding: 3, resource: buf(this.args) },
      ],
    });
    this.drawGroup = device.createBindGroup({
      layout: drawLayout,
      entries: [
        { binding: 0, resource: buf(this.simBuf) },
        { binding: 1, resource: buf(this.parts) },
        { binding: 2, resource: buf(this.alive) },
      ],
    });
    const mod = device.createShaderModule({ label: 'particles', code: PARTICLES_WGSL });
    const cpl = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, computeLayout] });
    this.spawnPipe = device.createComputePipeline({ label: 'particles spawn', layout: cpl, compute: { module: mod, entryPoint: 'spawn' } });
    this.simPipe = device.createComputePipeline({ label: 'particles simulate', layout: cpl, compute: { module: mod, entryPoint: 'simulate' } });
    const tested: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' };
    // the same, drawn after the volumetric clouds into the resolved frame (drawOver): one sample, the
    // scene's depth read by hand
    this.depthLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled: true } }] });
    const over = (label: string, module: GPUShaderModule, groupLayout: GPUBindGroupLayout) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, groupLayout, this.depthLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsOver', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      });
    this.drawPipe = device.createRenderPipeline({
      label: 'particles',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, drawLayout] }),
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: { count: SAMPLES },
    });
    this.drawOverPipe = over('particles over clouds', mod, drawLayout);
    // fields
    this.fieldBuf = device.createBuffer({ label: 'fields', size: this.fieldData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const fieldLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VS, buffer: { type: 'uniform' } }] });
    this.fieldGroup = device.createBindGroup({ layout: fieldLayout, entries: [{ binding: 0, resource: buf(this.fieldBuf) }] });
    const fmod = device.createShaderModule({ label: 'fields', code: FIELDS_WGSL });
    this.fieldPipe = device.createRenderPipeline({
      label: 'fields',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, fieldLayout] }),
      vertex: { module: fmod, entryPoint: 'vs' },
      fragment: { module: fmod, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: { count: SAMPLES },
    });
    this.fieldOverPipe = over('fields over clouds', fmod, fieldLayout);
  }

  /** The scene's depth (a new frame size), for drawOver. */
  setDepth(depth: GPUTexture) {
    this.depthGroup = this.device.createBindGroup({ layout: this.depthLayout, entries: [{ binding: 0, resource: depth.createView() }] });
  }

  /** Start a frame's list of emitters and fields. */
  begin() {
    this.emitters = [];
    this.fields = [];
  }

  emit(e: Emitter) {
    if (this.emitters.length >= MAX_EMITTERS) return;
    // whole particles now; the fraction carries over (a low rate still spawns, now and then)
    let n = e.count + (e.key ? (this.carry.get(e.key) ?? 0) : 0);
    const whole = Math.floor(n);
    if (e.key) this.carry.set(e.key, n - whole);
    n = whole;
    if (n <= 0) return;
    this.emitters.push({ ...e, count: n });
  }

  field(f: Field) {
    if (this.fields.length < MAX_FIELDS) this.fields.push(f);
  }

  /** The frame's spawning and simulation (before the scene pass). `dt`: sim seconds since the last frame. */
  compute(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, g: Game, dt: number) {
    const u32 = new Uint32Array(this.simData),
      f32 = new Float32Array(this.simData);
    const cv = g.ship.vel;
    f32.set([cv.x, cv.y, cv.z, dt], 0);
    let n = 0;
    this.emitters.forEach((e, k) => {
      const o = 12 + k * 24;
      const d = e.dir ?? new THREE.Vector3();
      f32.set([e.pos.x, e.pos.y, e.pos.z, n], o);
      f32.set([e.vel.x, e.vel.y, e.vel.z, e.count], o + 4);
      f32.set([d.x, d.y, d.z, e.speed ?? 0], o + 8);
      f32.set([...e.color, e.size], o + 12);
      f32.set([e.life, e.lifeJitter ?? 0.3, e.spread ?? 0, e.region ?? 0], o + 16);
      f32.set([e.growth ?? 0, e.drag ?? 0, e.streak ?? 0, e.fadeIn ?? 0], o + 20);
      n += e.count;
    });
    n = Math.min(n, CAP);
    u32.set([this.head, n, this.emitters.length, CAP, this.seed++], 4);
    this.device.queue.writeBuffer(this.simBuf, 0, this.simData);
    this.device.queue.writeBuffer(this.args, 0, new Uint32Array([6, 0, 0, 0]));
    this.head = (this.head + n) % CAP;
    // fields
    const fd = this.fieldData;
    this.fields.forEach((fl, k) => {
      const o = k * 20;
      const a = fl.at;
      const w = (v: number) => (fl.mode === 'wrap' ? v - Math.floor(v / fl.size) * fl.size : v);
      fd.set([w(a.x), w(a.y), w(a.z), fl.mode === 'wrap' ? 0 : 1], o);
      fd.set([fl.size, fl.count, fl.seed, fl.grain], o + 4);
      fd.set([...fl.color, fl.glint ?? 0], o + 8);
      const s = g.cur.star.pos.clone().sub(g.ship.pos).normalize();
      fd.set([s.x, s.y, s.z, (performance.now() / 1000) % 1e5], o + 12);
      fd.set([fl.drift ?? 0, fl.streak?.x ?? 0, fl.streak?.y ?? 0, fl.streak?.z ?? 0], o + 16);
    });
    if (this.fields.length) this.device.queue.writeBuffer(this.fieldBuf, 0, fd);
    this.live = this.live || n > 0;
    if (!this.live) return;
    const pass = enc.beginComputePass({ label: 'particles' });
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, this.computeGroup);
    if (n) {
      pass.setPipeline(this.spawnPipe);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
    }
    pass.setPipeline(this.simPipe);
    pass.dispatchWorkgroups(CAP / 64);
    pass.end();
  }

  /**
   * Transparent, added light: the living particles, then the fields. In the scene pass (`over`
   * false), or with volumetric clouds, after they're laid over the frame (into the resolved frame,
   * `over` true): drawn in the scene, the clouds went over them too, and plasma streaming past the
   * hull showed only dimly, as if beyond the clouds.
   */
  draw(pass: GPURenderPassEncoder, over = false) {
    if (over) {
      if (!this.depthGroup) return;
      pass.setBindGroup(2, this.depthGroup);
    }
    if (this.live) {
      pass.setPipeline(over ? this.drawOverPipe : this.drawPipe);
      pass.setBindGroup(1, this.drawGroup);
      pass.drawIndirect(this.args, 0);
    }
    if (this.fields.length) {
      pass.setPipeline(over ? this.fieldOverPipe : this.fieldPipe);
      pass.setBindGroup(1, this.fieldGroup);
      this.fields.forEach((fl, k) => pass.draw(6, fl.count, 0, k << 20));
    }
  }

  dispose() {
    for (const b of [this.simBuf, this.parts, this.alive, this.args, this.fieldBuf]) b.destroy();
  }
}
