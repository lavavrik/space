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
import { deckHeight } from '../sim/cloudKind';
import { atmoOf } from '../sim/atmosphere';
import { strikeGlow } from '../sim/lightning';
import { MAX_RENDER_PIXELS } from '../render/look';
import { DynamicResolution } from './dynres';
import { TerrainSweep } from '../debug/tdbg';
import { CostSweep, gpuSkip } from '../debug/costSweep';
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
import { SwarmLayer } from './swarm';
import { GpuTimer } from './timing';
import { WorldsLayer } from './worlds';
import { setTerrainDetail } from './terrain';

/** Near plane (m): with reversed-Z and 32-bit float depth, precision barely depends on it. */
const NEAR = 0.5;
/** Bytes in the per-frame uniform block (frame.wgsl Frame): two mat4, 12 floats, a vec4, 4 floats, 3 vec4. */
const FRAME_BYTES = 256;

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
  private readonly swarm: SwarmLayer;
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
    this.swarm = new SwarmLayer(device, this.frameLayout, this.shadows.casterLayout);
    this.fx = new EffectsLayer(device, this.frameLayout, this.shadows.casterLayout);
    this.vclouds = new VolumetricClouds(device, this.frameLayout, this.worlds.worldLayout, this.worlds.coverLayout, NEAR);
    this.toneBuf = device.createBuffer({ label: 'post', size: POST_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloom = new Bloom(device);
    this.toneSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.hyper = new HyperspaceLayer(device, this.frameLayout);
    this.particles = new Particles(device, this.frameLayout);
    this.meter = new Meter(device);
    this.timer = gpu.timestamps ? new GpuTimer(device, (slot, parts, span) => perf.gpuResult(slot, parts, span)) : null;
    perf.gpuTimed = !!this.timer;
    perf.info2 = () => this.worlds.terrainStats();
    // (the march's settings only while it runs: it read "clouds march 778×402" from 13,000 km out,
    // where the volumetric clouds are off and the flat deck draws them)
    perf.info3 = () => (this.worlds.vcOn > 0 ? this.vclouds.describe() : 'clouds: volumetric off (on within 40 deck heights of a clouded world: ~400 km at an Earth) · flat deck');
    perf.pacing = () => ({ refresh: this.dynres.refresh, scale: this.dynres.on ? this.dynres.scale : NaN });
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

  /** Shift+`: time the terrain with each part of its pixel shader off in turn (debug/tdbg.ts). */
  terrainSweep() {
    if (!this.timer) return;
    this.costSweepRun?.cancel();
    const sweep = new TerrainSweep(this.perf, this.dynres);
    this.perf.onGpu = (parts) => sweep.sample(parts);
  }

  /** The cost sweep under way (Alt+`), if any. */
  private costSweepRun: CostSweep | null = null;
  /** Alt+`: the scene's GPU cost by part, each left out of the frame in turn (debug/costSweep.ts). */
  costSweep() {
    if (!this.timer) return;
    this.costSweepRun?.cancel();
    const sweep = (this.costSweepRun = new CostSweep(this.perf, this.dynres));
    this.perf.onGpu = (_parts, span) => sweep.sample(span);
  }

  /** The Settings panel's graphics options (game/settings.ts), applied now. */
  applySettings(s: Settings) {
    this.settings = s;
    this.dynres.enable(s.dynres);
    this.worlds.cloudsOn = s.clouds !== 'off';
    this.vclouds.quality = s.clouds === 'low' ? 0.5 : 1;
    this.vclouds.full = s.clouds === 'ultra';
    // (High at half resolution up to the scene's 5 MP budget; Low capped lower, for weaker GPUs)
    this.vclouds.maxPixels = s.clouds === 'low' ? 400e3 : 1.3e6;
    // (the sun's shadow map costs the same at any size: worth it only marching every frame pixel)
    this.vclouds.interleave = s.cloudSpeedups;
    this.vclouds.sunMapOn = s.clouds === 'ultra' && s.cloudSpeedups;
    setTerrainDetail(s.terrain === 'low');
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
      // (and to an overcast, under the clouds or in them, up to the layer's top, 1.05 deck heights:
      // vclouds.wgsl; stopping at the base, the inside of a thick cloud was a dark murk)
      // (dust storms too: sim/cloudKind.ts)
      const deckH = deckHeight(fb);
      if (fb.kind !== 'star' && deckH > 0) {
        twK *= overcastBoost(cloudCoverAt(fb, up, g.simTime), 1 - THREE.MathUtils.smoothstep(alt, deckH * 0.9, deckH * 1.1));
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
    // the latest lightning strike near you, while it lasts (sim/lightning.ts)
    f.fill(0, 56, 64);
    const st = g.lightning.strikes[g.lightning.strikes.length - 1];
    const sk = st ? strikeGlow(g.simTime - st.t0) : 0;
    if (st && sk > 0) {
      const lp = this.tw.copy(st.ground).lerp(st.top, 0.33).sub(ship.pos);
      f.set([lp.x, lp.y, lp.z, sk], 56);
      const tp = this.tw2.copy(st.top).sub(ship.pos);
      f.set([tp.x, tp.y, tp.z, 0], 60);
    }
    device.queue.writeBuffer(this.frameBuf, 0, f);
    this.updateViews(g);
    this.sky.update(g, this.W, this.H);
    if (inTunnel) this.hyper.update(g.jump!);
    else {
      this.hyper.release();
      this.worlds.update(g);
      this.stations.update(g, this.worlds);
      this.swarm.update(g);
      this.particles.begin();
      this.fx.update(g, this.worlds, this.particles, this.PR);
      this.worlds.flushDots();
      // shadows while something near can cast them: rocks, other ships, a station
      this.shadows.update(g, this.settings.shadows && !gpuSkip.has('shadow map') && (this.worlds.rocksOut || this.fx.hullCount > 0 || this.stations.near(30e3) || this.swarm.casting));
    }

    const enc = device.createCommandEncoder({ label: 'frame' });
    // timing (the overlay up): each pass's timestamps, and the scene split into passes
    // (closing the overlay stops a cost sweep: no more samples would come, and its part would stay off)
    if (this.costSweepRun && !this.costSweepRun.done && !this.perf.visible) this.costSweepRun.cancel();
    const timed = !!this.timer && this.perf.splitting && this.timer.begin();
    // the scene as separate passes only for the terrain sweep, which reads its 'terrain' pass: split,
    // each pass's time takes in the MSAA frame's reload and store and the last pass's spill (an empty
    // pass read ms on Apple GPUs, SPACE-94), so normally it's one 'scene' pass and Alt+` measures
    // its parts by leaving them out (debug/costSweep.ts)
    const split = timed && this.perf.splitPasses;
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
          this.swarm.drawShadow(pass);
        },
        tw,
      );
    }
    const hdrView = this.hdr.createView(),
      depthView = this.depth.createView();
    // volumetric clouds near a clouded world (they read the scene's depth, so it's kept)
    const clouds = !inTunnel && this.worlds.vcOn > 0 && !gpuSkip.has('volumetric clouds');
    // the terrain skips shading what last frame's clouds hid (vclouds.ts coverFor)
    this.worlds.cover = this.vclouds.coverFor(clouds ? this.worlds.vcGroup : null, this.worlds.vcRel, this.worlds.vcQ, this.worlds.vcLift);
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
    // (each part can be left out by the cost sweep, gpuSkip: debug/costSweep.ts)
    const on = (part: string) => !gpuSkip.has(part);
    const sky = (pass: GPURenderPassEncoder) => on('sky') && this.sky.draw(pass, !inTunnel);
    const far = (pass: GPURenderPassEncoder) => on('far bodies') && this.worlds.drawFar(pass);
    const terrain = (pass: GPURenderPassEncoder) => on('terrain') && this.worlds.drawTerrain(pass);
    const rocks = (pass: GPURenderPassEncoder) => on('rocks') && this.worlds.drawRocks(pass);
    const bodies = (pass: GPURenderPassEncoder) => {
      far(pass);
      terrain(pass);
      rocks(pass);
    };
    const craft = (pass: GPURenderPassEncoder) => {
      if (on('stations')) this.stations.drawOpaque(pass);
      if (on('swarm')) this.swarm.drawOpaque(pass);
      if (on('ships')) this.fx.drawOpaque(pass);
    };
    const transparent = (pass: GPURenderPassEncoder) =>
      this.worlds.drawTransparent(pass, (p) => {
        if (on('stations')) this.stations.drawTransparent(p);
        if (on('ships')) this.fx.drawTransparent(p);
        if (!clouds && on('particles')) this.particles.draw(p);
      });
    if (inTunnel)
      scene('hyperspace', true, true, (pass) => {
        sky(pass);
        pass.setPipeline(this.sky.starsPipe);
        this.hyper.drawHeads(pass);
        this.hyper.drawStreaks(pass);
      });
    else if (split) {
      scene('sky', true, false, sky);
      // (bodies in three, to see which costs: the far spheres, the terrain, the ring rocks)
      scene('far bodies', false, false, far);
      scene('terrain', false, false, terrain);
      scene('rocks', false, false, rocks);
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
      if (on('particles')) this.particles.draw(over, true);
      over.end();
    }
    if (AUTO_EXPOSURE) this.meter.encode(enc, e);

    // (left out by the cost sweep, the tone map reads last frame's bloom: the picture's off, the cost is right)
    if (this.settings.bloom && !gpuSkip.has('bloom')) this.bloom.render(enc, tw);
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
    this.swarm.dispose();
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
