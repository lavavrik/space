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
import { sunsAt, type Suns } from '../sim/starlight';
import { AUTO_EXPOSURE, AutoExposure, FLOOD_K, HEAD_K, INT_K, MAX_EXP, SKY_EXP_P, SKY_K, STAR_EXP_P, WINDOW_K, overcastBoost, twilightBoost } from '../render/exposure';
import { cloudCoverAt } from '../sim/clouds';
import { CLOUD_H } from '../render/look';
import { atmoOf } from '../sim/atmosphere';
import { WT } from '../constants';
import { MAX_RENDER_PIXELS } from '../render/look';
import { DynamicResolution } from './dynres';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import type { Body, CurrentSystem, StarSystem, Station } from '../types';
import type { Gpu } from './device';
import { EffectsLayer } from './effects';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { HyperspaceLayer } from './hyperspace';
import { Particles } from './particles';
import { Bloom, POST_FLOATS, postParams } from './post';
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
const FRAME_BYTES = 224;

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
  private readonly tw = new THREE.Vector3();
  private readonly tw2 = new THREE.Vector3();
  private readonly suns: Suns = { s1: null as unknown as Suns['s1'], s2: null, c2: new THREE.Color() };
  private readonly meter: Meter;
  private readonly timer: GpuTimer | null;
  private hdr!: GPUTexture;
  private resolved!: GPUTexture;
  private depth!: GPUTexture;
  private toneGroups: GPUBindGroup[] = [];
  /** The 3D scene's render size (px) and pixels per CSS px: the canvas's × the dynamic scale. */
  private W = 1;
  private H = 1;
  private PR = 1;
  /** The canvas: its size (px) and pixels per CSS px. */
  private CW = 1;
  private CH = 1;
  private basePR = 1;
  /** The scene's resolution, kept up with the display (gpu/dynres.ts). */
  readonly dynres = new DynamicResolution();
  /** The Settings panel's (applySettings), and the CSS size last given to resize. */
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private cssW = 1;
  private cssH = 1;
  private readonly views = new Map<Body | Station, ViewInfo>();
  private readonly proj = new THREE.Matrix4();
  private readonly viewM = new THREE.Matrix4();
  private readonly rot = new THREE.Matrix4();
  private readonly vp = new THREE.Matrix4();
  private readonly head = new THREE.Vector3();
  private readonly land = new THREE.Vector3();

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
        // (the volumetric clouds read it too: a sky station's shadow on them)
        { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
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
    this.toneBuf = device.createBuffer({ label: 'post', size: POST_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloom = new Bloom(device);
    this.toneSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.hyper = new HyperspaceLayer(device, this.frameLayout);
    this.particles = new Particles(device, this.frameLayout);
    this.meter = new Meter(device);
    this.timer = gpu.timestamps ? new GpuTimer(device, (slot, parts) => perf.gpuResult(slot, parts)) : null;
    perf.gpuTimed = !!this.timer;
    perf.info2 = () => this.worlds.terrainStats();
    perf.info = () => `WebGPU ${this.W}×${this.H} @${this.PR.toFixed(2)}${this.dynres.scale < 1 ? ` (${Math.round(this.dynres.scale * 100)} %)` : ''}`;
  }

  setSystem(cur: CurrentSystem, sky: StarSystem[]) {
    this.views.clear();
    this.sky.setSystem(cur, sky);
    this.worlds.setSystem(cur);
    this.stations.setSystem(cur, this.worlds);
  }

  /** The canvas: up to 1.5× the CSS resolution, at most MAX_RENDER_PIXELS (render/look.ts). */
  resize(W: number, H: number) {
    this.cssW = W;
    this.cssH = H;
    this.basePR = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, W * H)));
    this.CW = Math.max(1, Math.round(W * this.basePR));
    this.CH = Math.max(1, Math.round(H * this.basePR));
    this.canvas.width = this.CW;
    this.canvas.height = this.CH;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.setScale(this.dynres.scale);
  }

  /**
   * At the end of each frame (Game.frame): its start (rAF time, ms) and the CPU's time over it (ms),
   * for the dynamic resolution; the render targets are remade when it changes.
   */
  pace(now: number, cpuMs: number) {
    const s = this.dynres.frame(now, cpuMs);
    if (s !== null) this.setScale(s);
  }

  /** The Settings panel's graphics options (game/settings.ts), applied now. */
  applySettings(s: Settings) {
    this.settings = s;
    this.dynres.enable(s.dynres);
    this.worlds.cloudsOn = s.clouds !== 'off';
    this.vclouds.quality = s.clouds === 'low' ? 0.5 : 1;
    this.resize(this.cssW, this.cssH);
  }

  /** The scene's render targets at `scale` × the canvas's resolution (the final pass scales up). */
  private setScale(scale: number) {
    // (at most the Settings panel's resolution: the dynamic one scales within it)
    const k = scale * this.settings.resScale;
    this.PR = this.basePR * k;
    this.W = Math.max(1, Math.round(this.CW * k));
    this.H = Math.max(1, Math.round(this.CH * k));
    this.worlds.pr = this.PR;
    this.hdr?.destroy();
    this.resolved?.destroy();
    this.depth?.destroy();
    const size = [this.W, this.H];
    this.hdr = this.device.createTexture({ label: 'hdr', size, format: HDR_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.resolved = this.device.createTexture({ label: 'hdr resolved', size, format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    // (the depth is read after the scene by the volumetric clouds)
    this.depth = this.device.createTexture({ label: 'depth', size, format: DEPTH_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.vclouds.resize(this.depth, this.W, this.H);
    this.particles.setDepth(this.depth);
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
          { binding: 5, resource: this.depth.createView() }, // (the space warps bend only what's behind them)
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
    // (a pair's second sun adds its light to the first's, docs/binaries.md: the eye takes both as one
    // day's light, as a lone star of the same total would give, so the scene isn't brighter for it)
    const suns = sunsAt(g.cur.stars, ship.pos, this.suns);
    let twK = 1;
    let e = this.exposure.value / (1 + (suns.s2 ? Math.max(suns.c2.r, suns.c2.g, suns.c2.b) : 0));
    // (and the eye adapting to twilight, in the air: render/exposure.ts twilightBoost)
    const fb = g.frameBody;
    const air = !AUTO_EXPOSURE && fb.kind !== 'star' ? atmoOf(fb) : null;
    if (air) {
      const up = this.tw.subVectors(ship.pos, fb.pos);
      const alt = up.length() - fb.radius;
      up.normalize();
      let sinEl = -1;
      for (const st of g.cur.stars) sinEl = Math.max(sinEl, this.tw2.subVectors(st.pos, ship.pos).normalize().dot(up));
      twK = twilightBoost(sinEl, alt / air.H);
      // (and to an overcast, under the cloud base, 0.4 deck heights: vclouds.wgsl)
      if (fb.kind !== 'star' && (fb.type === WT.EarthLike || fb.type === WT.Ocean)) {
        twK *= overcastBoost(cloudCoverAt(fb, up, g.simTime), 1 - THREE.MathUtils.smoothstep(alt, air.H * CLOUD_H * 0.3, air.H * CLOUD_H * 0.5));
      }
      e *= twK;
    }
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
    f.set([this.head.x, this.head.y, this.head.z, g.lights ? 1 : 0, INT_K, WINDOW_K, SKY_K, twK], 44);
    // the landing lights: down from under the hull, a little forward (sim/landingLights.ts)
    this.land.set(0, -1, -0.35).normalize().applyQuaternion(ship.q);
    f.set([this.land.x, this.land.y, this.land.z, g.landingLights ? 1 : 0], 52);
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
    // (the clouds are laid over the frame in their own pass, before the particles, not by the tone map)
    const pp = postParams(g, this.vp, false, this.CW, this.CH, this.settings);
    device.queue.writeBuffer(this.toneBuf, 0, pp);
    // (the depth is kept for the final pass while a warp is on: it bends only what's behind it)
    const keepDepth = clouds || pp[16] > 0;
    const scene = (label: string, first: boolean, last: boolean, draw: (pass: GPURenderPassEncoder) => void) => {
      const pass = enc.beginRenderPass({
        label,
        colorAttachments: [{ view: hdrView, resolveTarget: last ? this.resolved.createView() : undefined, loadOp: first ? 'clear' : 'load', storeOp: last ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: depthView, depthLoadOp: first ? 'clear' : 'load', depthStoreOp: last && !keepDepth ? 'discard' : 'store', depthClearValue: 0 },
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
        if (!clouds) this.particles.draw(p);
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
    this.vclouds.dispatch(enc, this.frameGroup, clouds ? this.worlds.vcGroup : null, this.worlds.vcOn, this.vp, this.worlds.vcRel, this.worlds.vcQ, this.worlds.vcLift, tw);
    if (clouds) {
      // the clouds over the frame, then the particles over them (they're near: plasma, exhaust)
      const over = enc.beginRenderPass({ label: 'clouds over', colorAttachments: [{ view: this.resolved.createView(), loadOp: 'load', storeOp: 'store' }] });
      this.vclouds.composite(over, this.frameGroup, this.worlds.vcGroup!);
      over.setBindGroup(0, this.frameGroup);
      this.particles.draw(over, true);
      over.end();
    }
    if (AUTO_EXPOSURE) this.meter.encode(enc, e);

    if (this.settings.bloom) this.bloom.render(enc, tw);
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
