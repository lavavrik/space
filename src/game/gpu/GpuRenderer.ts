/**
 * The renderer, on WebGPU (docs/webgpu.md):
 *   - the sky (gpu/sky.ts): the Milky Way, the periscope's patch, the stars;
 *   - the system's bodies (gpu/worlds.ts): the star, planets, terrain up close (gpu/terrain.ts),
 *     skies, cloud decks, rings and their rocks (gpu/rings.ts), dots for distant things;
 *   - stations (gpu/stations.ts), ships and effects (gpu/effects.ts), hyperspace (gpu/hyperspace.ts).
 *
 * A frame:
 *   1. compute: terrain chunks' bakes, the ring rocks' culling;
 *   2. the scene into `hdr` (rgba16float, 4× MSAA, resolved into `resolved`), with a depth32float
 *      buffer, reversed-Z (cleared to 0, `greater` passes), infinite far plane: sky, opaque things,
 *      then transparent ones, every physical light × the exposure (render/exposure.ts);
 *   3. with auto-exposure on, the meter (gpu/meter.ts), read back a frame or two later;
 *   4. the tone map from `resolved` to the canvas.
 * With the performance overlay up (and timestamp queries there), the scene is split into passes and
 * each is timed (gpu/timing.ts).
 * Positions are camera-relative (world − ship), in doubles on the CPU, then 32-bit on the GPU.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { PerfMonitor } from '../debug/Perf';
import type { GameRenderer, ViewInfo } from '../render/api';
import { AUTO_EXPOSURE, AutoExposure, FLOOD_K, HEAD_K, INT_K, MAX_EXP, SKY_EXP_P, SKY_K, STAR_EXP_P, WINDOW_K } from '../render/exposure';
import { MAX_RENDER_PIXELS } from '../render/look';
import type { Body, CurrentSystem, StarSystem, Station } from '../types';
import type { Gpu } from './device';
import { EffectsLayer } from './effects';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { HyperspaceLayer } from './hyperspace';
import { Particles } from './particles';
import { Bloom, postParams } from './post';
import { Meter } from './meter';
import { TONEMAP_WGSL } from './shaders';
import { ShadowMap } from './shadowmap';
import { SkyLayer } from './sky';
import { VolumetricClouds } from './vclouds';
import { StationsLayer } from './stations';
import { GpuTimer } from './timing';
import { WorldsLayer } from './worlds';

/** Near plane (m): with reversed-Z and 32-bit float depth, precision barely depends on it. */
const NEAR = 0.5;
/** Bytes in the per-frame uniform block (frame.wgsl Frame): two mat4, 12 floats, a vec4, 4 floats. */
const FRAME_BYTES = 208;

export class GpuRenderer implements GameRenderer {
  readonly kind = 'webgpu' as const;
  readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly frameGroup: GPUBindGroup;
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly tonePipe: GPURenderPipeline;
  private readonly sky: SkyLayer;
  private readonly shadows: ShadowMap;
  private readonly vclouds: VolumetricClouds;
  private readonly toneBuf: GPUBuffer;
  private readonly toneSamp: GPUSampler;
  private readonly bloom: Bloom;
  private readonly worlds: WorldsLayer;
  private readonly stations: StationsLayer;
  private readonly fx: EffectsLayer;
  private readonly hyper: HyperspaceLayer;
  private readonly particles: Particles;
  private lastSim = 0;
  private readonly exposure = new AutoExposure();
  private readonly meter: Meter;
  private readonly timer: GpuTimer | null;
  private hdr!: GPUTexture;
  private resolved!: GPUTexture;
  private depth!: GPUTexture;
  private toneGroups: GPUBindGroup[] = [];
  private W = 1;
  private H = 1;
  private PR = 1;
  private readonly views = new Map<Body | Station, ViewInfo>();
  private readonly proj = new THREE.Matrix4();
  private readonly viewM = new THREE.Matrix4();
  private readonly rot = new THREE.Matrix4();
  private readonly vp = new THREE.Matrix4();
  private readonly head = new THREE.Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    gpu: Gpu,
    private readonly perf: PerfMonitor,
  ) {
    const { device, format } = gpu;
    this.device = device;
    this.context = canvas.getContext('webgpu')!;
    this.context.configure({ device, format, alphaMode: 'opaque' });

    this.frameBuf = device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // group 0: the frame's uniforms, and the shadow map (gpu/shadowmap.ts) for whatever reads it
    this.shadows = new ShadowMap(device);
    const ALL = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.frameLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: ALL, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: ALL, buffer: { type: 'uniform' } },
      ],
    });
    this.frameGroup = device.createBindGroup({
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: this.shadows.texture.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: this.shadows.sampler },
        { binding: 3, resource: { buffer: this.shadows.uniform } },
      ],
    });

    // tone map to the canvas
    const toneModule = device.createShaderModule({ label: 'tonemap', code: TONEMAP_WGSL });
    this.tonePipe = device.createRenderPipeline({
      label: 'tonemap',
      layout: 'auto',
      vertex: { module: toneModule, entryPoint: 'vs' },
      fragment: { module: toneModule, entryPoint: 'fs', targets: [{ format }] },
    });

    this.sky = new SkyLayer(device, this.frameLayout);
    this.worlds = new WorldsLayer(device, this.frameLayout, this.shadows.casterLayout);
    this.stations = new StationsLayer(device, this.frameLayout, this.worlds.worldLayout, this.shadows.casterLayout);
    this.fx = new EffectsLayer(device, this.frameLayout, this.shadows.casterLayout);
    this.vclouds = new VolumetricClouds(device, this.frameLayout, this.worlds.worldLayout, NEAR);
    this.toneBuf = device.createBuffer({ label: 'post', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloom = new Bloom(device);
    this.toneSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.hyper = new HyperspaceLayer(device, this.frameLayout);
    this.particles = new Particles(device, this.frameLayout);
    this.meter = new Meter(device);
    this.timer = gpu.timestamps ? new GpuTimer(device, (slot, parts) => perf.gpuResult(slot, parts)) : null;
    perf.gpuTimed = !!this.timer;
    perf.info = () => `WebGPU ${this.W}×${this.H} @${this.PR.toFixed(2)}`;
  }

  setSystem(cur: CurrentSystem, sky: StarSystem[]) {
    this.views.clear();
    this.sky.setSystem(cur, sky);
    this.worlds.setSystem(cur);
    this.stations.setSystem(cur, this.worlds);
  }

  /** Up to 1.5× the CSS resolution, at most MAX_RENDER_PIXELS (render/look.ts). */
  resize(W: number, H: number) {
    this.PR = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, W * H)));
    this.W = Math.max(1, Math.round(W * this.PR));
    this.H = Math.max(1, Math.round(H * this.PR));
    this.worlds.pr = this.PR;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.hdr?.destroy();
    this.resolved?.destroy();
    this.depth?.destroy();
    const size = [this.W, this.H];
    this.hdr = this.device.createTexture({ label: 'hdr', size, format: HDR_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.resolved = this.device.createTexture({ label: 'hdr resolved', size, format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    // (the depth is read after the scene by the volumetric clouds)
    this.depth = this.device.createTexture({ label: 'depth', size, format: DEPTH_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.vclouds.resize(this.depth, this.W, this.H);
    // one per volumetric-cloud texture (they ping-pong)
    this.bloom.resize(this.resolved, this.W, this.H);
    const bl = this.bloom.views;
    this.toneGroups = [0, 1].map((k) =>
      this.device.createBindGroup({
        layout: this.tonePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.resolved.createView() },
          { binding: 1, resource: this.vclouds.view(k) },
          { binding: 2, resource: this.toneSamp },
          { binding: 3, resource: { buffer: this.toneBuf } },
          { binding: 4, resource: bl.bloom },
        ],
      }),
    );
    this.meter.resize(this.resolved, this.W, this.H);
  }

  /**
   * Reversed-Z perspective with an infinite far plane: depth = NEAR / distance, 1 at the near plane
   * falling to 0 at infinity (clip z in WebGPU's 0…1).
   */
  private projection(fovDeg: number) {
    const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
    const a = this.W / this.H;
    return this.proj.set(f / a, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, NEAR, 0, 0, -1, 0);
  }

  render(g: Game) {
    const { device } = this;
    const { ship } = g;
    // in hyperspace: only the Milky Way and the real stars streaming past, no system scene
    const inTunnel = !!g.jump && g.jump.phase === 'tunnel';
    // the eye's adaptation (render/exposure.ts): the Milky Way and the stars follow only part of it
    this.exposure.update(this.meter.collect());
    const e = this.exposure.value;
    const skyExp = AUTO_EXPOSURE ? (e / MAX_EXP) ** SKY_EXP_P : 1,
      starExp = AUTO_EXPOSURE ? (e / MAX_EXP) ** STAR_EXP_P : 1;
    this.worlds.starExp = starExp;
    // per-frame uniforms
    const P = this.projection(g.fov);
    this.rot.makeRotationFromQuaternion(ship.q);
    this.viewM.copy(this.rot).invert();
    this.vp.multiplyMatrices(P, this.viewM);
    const f = this.frameData;
    f.set(this.vp.elements, 0);
    f.set(this.rot.elements, 16);
    f.set([this.W, this.H, P.elements[0], P.elements[5], this.PR, g.simTime, e, skyExp, starExp, HEAD_K, FLOOD_K, HEAD_K / INT_K], 32);
    this.head.set(0, 0, -1).applyQuaternion(ship.q);
    f.set([this.head.x, this.head.y, this.head.z, g.lights ? 1 : 0, INT_K, WINDOW_K, SKY_K], 44);
    device.queue.writeBuffer(this.frameBuf, 0, f);
    this.updateViews(g);
    this.sky.update(g, this.W, this.H);
    if (inTunnel) this.hyper.update(g.jump!);
    else {
      this.hyper.release();
      this.worlds.update(g);
      this.stations.update(g, this.worlds);
      this.particles.begin();
      this.fx.update(g, this.worlds, this.particles, this.PR);
      this.worlds.flushDots();
      // shadows while something near can cast them: rocks, other ships, a station
      this.shadows.update(g, this.worlds.rocksOut || this.fx.hullCount > 0 || this.stations.near(30e3));
    }

    const enc = device.createCommandEncoder({ label: 'frame' });
    // timing (the overlay up): each pass's timestamps, and the scene split into passes
    const timed = !!this.timer && this.perf.splitting && this.timer.begin();
    const tw = (label: string) => this.timer?.pass(label, timed);
    const dt = Math.max(0, Math.min(0.1, g.simTime - this.lastSim));
    this.lastSim = g.simTime;
    if (!inTunnel) {
      this.worlds.bake(enc, this.frameGroup, tw);
      this.particles.compute(enc, this.frameGroup, g, dt);
      // the shadow map, from the star (after the rock culling: the rocks' lists)
      this.shadows.render(
        enc,
        (pass, c) => {
          const R = this.shadows.radii[c];
          this.worlds.drawShadow(pass, R, (2 * R) / 2048);
          this.stations.drawShadow(pass, R);
          this.fx.drawShadow(pass);
        },
        tw,
      );
    }
    const hdrView = this.hdr.createView(),
      depthView = this.depth.createView();
    // volumetric clouds near a clouded world (they read the scene's depth, so it's kept)
    const clouds = !inTunnel && this.worlds.vcOn > 0;
    device.queue.writeBuffer(this.toneBuf, 0, postParams(g, this.vp, clouds));
    const scene = (label: string, first: boolean, last: boolean, draw: (pass: GPURenderPassEncoder) => void) => {
      const pass = enc.beginRenderPass({
        label,
        colorAttachments: [{ view: hdrView, resolveTarget: last ? this.resolved.createView() : undefined, loadOp: first ? 'clear' : 'load', storeOp: last ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: depthView, depthLoadOp: first ? 'clear' : 'load', depthStoreOp: last && !clouds ? 'discard' : 'store', depthClearValue: 0 },
        timestampWrites: tw(label),
      });
      pass.setBindGroup(0, this.frameGroup);
      draw(pass);
      pass.end();
    };
    const sky = (pass: GPURenderPassEncoder) => this.sky.draw(pass, !inTunnel);
    const bodies = (pass: GPURenderPassEncoder) => this.worlds.drawOpaque(pass);
    const craft = (pass: GPURenderPassEncoder) => {
      this.stations.drawOpaque(pass);
      this.fx.drawOpaque(pass);
    };
    const transparent = (pass: GPURenderPassEncoder) =>
      this.worlds.drawTransparent(pass, (p) => {
        this.stations.drawTransparent(p);
        this.fx.drawTransparent(p);
        this.particles.draw(p);
      });
    if (inTunnel)
      scene('hyperspace', true, true, (pass) => {
        sky(pass);
        pass.setPipeline(this.sky.starsPipe);
        this.hyper.drawHeads(pass);
        this.hyper.drawStreaks(pass);
      });
    else if (timed) {
      scene('sky', true, false, sky);
      scene('bodies', false, false, bodies);
      scene('stations, ships', false, false, craft);
      scene('transparent', false, true, transparent);
    } else
      scene('scene', true, true, (pass) => {
        sky(pass);
        bodies(pass);
        craft(pass);
        transparent(pass);
      });
    this.vclouds.dispatch(enc, this.frameGroup, clouds ? this.worlds.vcGroup : null, this.worlds.vcOn, this.vp, g.ship.pos, tw);
    if (AUTO_EXPOSURE) this.meter.encode(enc, e);

    this.bloom.render(enc, tw);
    const tone = enc.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: tw('post'),
    });
    tone.setPipeline(this.tonePipe);
    tone.setBindGroup(0, this.toneGroups[this.vclouds.current]);
    tone.draw(3);
    tone.end();
    if (timed) this.timer!.end(enc, this.perf.slot);
    device.queue.submit([enc.finish()]);
    this.meter.submitted();
    this.timer?.submitted();
  }

  /** Each body's and station's distance and apparent size this frame, for the overlay. */
  private updateViews(g: Game) {
    const pxPerRad = g.view.pxPerRad;
    for (const b of g.cur.bodies) {
      const dist = b.pos.distanceTo(g.ship.pos);
      this.views.set(b, { dist, pxR: (b.radius / dist) * pxPerRad });
    }
    for (const st of g.cur.stations) {
      const dist = st.pos.distanceTo(g.ship.pos);
      this.views.set(st, { dist, pxR: (st.radius / dist) * pxPerRad });
    }
  }

  bodyView(b: Body) {
    return this.views.get(b);
  }
  stationView(st: Station) {
    return this.views.get(st);
  }

  dispose() {
    this.sky.dispose();
    this.worlds.dispose();
    this.stations.dispose();
    this.fx.dispose();
    this.hyper.dispose();
    this.particles.dispose();
    this.meter.dispose();
    this.vclouds.dispose();
    this.toneBuf.destroy();
    this.bloom.dispose();
    this.timer?.dispose();
    this.hdr?.destroy();
    this.resolved?.destroy();
    this.depth?.destroy();
    this.frameBuf.destroy();
    this.context.unconfigure();
  }
}
