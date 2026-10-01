/**
 * Volumetric clouds (docs/clouds.md; vclouds.wgsl): a half-resolution (at most MAX_PIXELS) compute pass over the frame,
 * after the scene (it reads the scene's depth), for the one clouded world you're near. `composite`
 * then lays its result over the resolved frame (scene × transmittance + cloud light), before the
 * particles are drawn over that (gpu/particles.ts drawOver), the bloom and the tone map.
 */
import { THREE } from '../lib/three';
import { VCLOUDS_WGSL } from './shaders';



/** vclouds.wgsl VParams: a mat4, a vec4, 12 floats. */
const PARAM_BYTES = 64 + 16 + 48;
/** The march's resolution: half the frame's, but at most this many pixels (`maxPixels`: Settings sets 1.3 MP for High, half
 *  resolution at the scene's 5 MP budget, and this for Low; ~4 ms at 1200 × 750 on an M-series GPU, before interleaving, was too much). */
const MAX_PIXELS = 400e3;
/** The sun's shadow map's size (texels a side; vclouds.wgsl SM_N). */
const SM_N = 384;

export class VolumetricClouds {
  private readonly pipe: GPUComputePipeline;
  /** Interleaved (vclouds.wgsl mainMarch, mainFill): a quarter of the pixels marched, the rest reprojected. */
  private readonly marchPipe: GPUComputePipeline;
  private readonly fillPipe: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  /** The sun's shadow map (vclouds.wgsl sunMap): its pass, written each frame before the march. */
  private readonly mapPipe: GPUComputePipeline;
  private readonly sunMap: GPUTexture;
  private readonly mapGroup: GPUBindGroup;
  private readonly params: GPUBuffer;
  private readonly data = new Float32Array(PARAM_BYTES / 4);
  /** Ping-pong: this frame's result and last frame's (the history it's blended with). */
  private tex: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private readonly compPipe: GPURenderPipeline;
  private compGroups: GPUBindGroup[] = [];
  private readonly compLayout: GPUBindGroupLayout;
  private cur = 0;
  private readonly samp: GPUSampler;
  /** Last frame's view-projection and camera position (doubles), for the reprojection. */
  private readonly prevVP = new Float32Array(16);
  /** Last frame's world (camera-relative) and turn, and which world it was. */
  private readonly prevRel = new THREE.Vector3();
  private readonly prevQ = new THREE.Quaternion();
  private prevGroup: GPUBindGroup | null = null;
  private hasPrev = false;
  private readonly reproj = new THREE.Matrix4();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private w = 1;
  private h = 1;
  private n = 0;
  /** Frame pixels per march pixel. */
  private scale = 2;
  /** Settings: the share of the steps marched (1, or 0.5 for 'low'). */
  quality = 1;
  /** March a quarter of the pixels a frame, the rest reprojected from the last (vclouds.wgsl main). */
  interleave = true;
  /** Work out the sun's shadow map (vclouds.wgsl sunMap) for the march's far sunlight. */
  sunMapOn = true;
  /** Settings ('ultra'): march every frame pixel, no cap (at half resolution, capped at MAX_PIXELS,
   *  the march's noise and its temporal blend can shimmer at cloud edges). Takes effect on resize. */
  full = false;
  /** The march's cap below Ultra (pixels; Settings: High's, Low's). */
  maxPixels = MAX_PIXELS;

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    worldLayout: GPUBindGroupLayout,
    private readonly near: number,
  ) {
    const CS = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: CS, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 1, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 2, visibility: CS, buffer: { type: 'uniform' } },
        { binding: 3, visibility: CS, texture: {} },
        { binding: 4, visibility: CS, sampler: {} },
        { binding: 5, visibility: CS, texture: {} },
      ],
    });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const module = device.createShaderModule({ label: 'volumetric clouds', code: VCLOUDS_WGSL });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, worldLayout, this.layout] });
    this.pipe = device.createComputePipeline({ label: 'volumetric clouds', layout: pl, compute: { module, entryPoint: 'main' } });
    this.marchPipe = device.createComputePipeline({ label: 'volumetric clouds (a quarter)', layout: pl, compute: { module, entryPoint: 'mainMarch' } });
    this.fillPipe = device.createComputePipeline({ label: 'volumetric clouds (the rest)', layout: pl, compute: { module, entryPoint: 'mainFill' } });
    // laying it over the frame (vclouds.wgsl fsComposite): the scene's depth, the params, the result
    const FS = GPUShaderStage.FRAGMENT;
    this.compLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FS, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 2, visibility: FS, buffer: { type: 'uniform' } },
        { binding: 3, visibility: FS, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const cm = module;
    this.compPipe = device.createRenderPipeline({
      label: 'clouds composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, worldLayout, this.compLayout] }),
      vertex: { module: cm, entryPoint: 'vsComposite' },
      // frame × a + rgb
      fragment: { module: cm, entryPoint: 'fsComposite', targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
    });
    this.params = device.createBuffer({ label: 'volumetric clouds', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the sun's shadow map: written by its own pass (the params, the map), read by the march
    const mapLayout = device.createBindGroupLayout({
      entries: [
        { binding: 2, visibility: CS, buffer: { type: 'uniform' } },
        { binding: 6, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    this.mapPipe = device.createComputePipeline({
      label: 'clouds sun map',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, worldLayout, mapLayout] }),
      compute: { module, entryPoint: 'sunMap' },
    });
    this.sunMap = device.createTexture({ label: 'clouds sun map', size: [SM_N, SM_N], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.mapGroup = device.createBindGroup({
      layout: mapLayout,
      entries: [
        { binding: 2, resource: { buffer: this.params } },
        { binding: 6, resource: this.sunMap.createView() },
      ],
    });
  }

  /** A new frame size: `depth` is the scene's (multisampled) depth. */
  resize(depth: GPUTexture, W: number, H: number) {
    for (const t of this.tex) t.destroy();
    const k = this.full ? 1 : Math.min(0.5, Math.sqrt(this.maxPixels / Math.max(1, W * H)));
    this.w = Math.max(1, Math.ceil(W * k));
    this.h = Math.max(1, Math.ceil(H * k));
    this.scale = 1 / k;
    this.tex = [0, 1].map(() => this.device.createTexture({ label: 'volumetric clouds', size: [this.w, this.h], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING }));
    // group k writes texture k and reads the other (last frame's)
    this.groups = [0, 1].map((k) =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: depth.createView() },
          { binding: 1, resource: this.tex[k].createView() },
          { binding: 2, resource: { buffer: this.params } },
          { binding: 3, resource: this.tex[1 - k].createView() },
          { binding: 4, resource: this.samp },
          { binding: 5, resource: this.sunMap.createView() },
        ],
      }),
    );
    this.compGroups = [0, 1].map((k) =>
      this.device.createBindGroup({
        layout: this.compLayout,
        entries: [
          { binding: 0, resource: depth.createView() },
          { binding: 2, resource: { buffer: this.params } },
          { binding: 3, resource: this.tex[k].createView() },
        ],
      }),
    );
    this.hasPrev = false;
  }

  /** Lay this frame's clouds over the frame (a pass on the resolved frame, after dispatch). */
  composite(pass: GPURenderPassEncoder, frameGroup: GPUBindGroup, worldGroup: GPUBindGroup) {
    pass.setPipeline(this.compPipe);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, worldGroup);
    pass.setBindGroup(2, this.compGroups[this.cur]);
    pass.draw(3);
  }

  /** This frame's result (rgb: the clouds' light, a: what they let through), for the tone map; `k`: which of the two. */
  view(k: number) {
    return this.tex[k].createView();
  }

  /** Which texture this frame writes (the tone map reads the same). */
  get current() {
    return this.cur;
  }

  /**
   * March the clouds of the world bound by `worldGroup`, faded in by `on` (0: skip); `vp` is this
   * frame's view-projection, `rel` the world's centre (camera-relative) and `q` its turn: for next
   * frame's reprojection, which follows the clouds as they turn and orbit with their world. `lift`
   * (m): the layer raised over the high ground under you (vclouds.wgsl liftAt).
   */
  dispatch(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, worldGroup: GPUBindGroup | null, on: number, vp: THREE.Matrix4, rel: THREE.Vector3, q: THREE.Quaternion, lift: number, tw: (label: string) => GPUComputePassTimestampWrites | undefined) {
    if (!worldGroup || on <= 0 || !this.groups.length) {
      this.hasPrev = false;
      return;
    }
    this.cur = 1 - this.cur;
    const d = this.data;
    // where a camera-relative point of the clouds now was last frame: into the world's own frame
    // (−rel, turned back by q⁻¹), then out by last frame's turn and place. Taking the clouds as still
    // in space instead, they were 30 km/s along the world's orbit off, and smeared upward (docs/clouds.md)
    if (worldGroup !== this.prevGroup) this.hasPrev = false;
    this.tmpQ.copy(q).invert().premultiply(this.prevQ);
    this.reproj.makeTranslation(-rel.x, -rel.y, -rel.z).premultiply(this.tmpM.makeRotationFromQuaternion(this.tmpQ)).premultiply(this.tmpM.makeTranslation(this.prevRel.x, this.prevRel.y, this.prevRel.z));
    this.reproj.premultiply(this.tmpM.fromArray(this.prevVP));
    d.set(this.reproj.elements, 0);
    d.set([0, 0, 0, this.hasPrev ? 1 : 0], 16);
    d.set([this.w, this.h, on, this.n++, this.near, this.scale, lift, this.quality, this.interleave ? 1 : 0, this.sunMapOn ? 1 : 0, 0, 0], 20);
    this.device.queue.writeBuffer(this.params, 0, d);
    this.prevVP.set(vp.elements);
    this.prevRel.copy(rel);
    this.prevQ.copy(q);
    this.prevGroup = worldGroup;
    this.hasPrev = true;
    // the sun's shadow map first (its own pass: the march reads it)
    if (this.sunMapOn) this.sunMapPass(enc, frameGroup, worldGroup, tw);
    pass_: {
      if (this.interleave) {
        // a quarter marched (each 2 × 2's pixel in turn), then the rest from last frame's: timed apart,
        // so a fill that costs as much as the march shows the reprojection being refused (marching anyway)
        const m = enc.beginComputePass({ label: 'clouds march', timestampWrites: tw('cloud march') });
        m.setBindGroup(0, frameGroup);
        m.setBindGroup(1, worldGroup);
        m.setBindGroup(2, this.groups[this.cur]);
        m.setPipeline(this.marchPipe);
        m.dispatchWorkgroups(Math.ceil(this.w / 16), Math.ceil(this.h / 16));
        m.end();
        const f = enc.beginComputePass({ label: 'clouds fill', timestampWrites: tw('cloud fill') });
        f.setBindGroup(0, frameGroup);
        f.setBindGroup(1, worldGroup);
        f.setBindGroup(2, this.groups[this.cur]);
        f.setPipeline(this.fillPipe);
        f.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
        f.end();
        break pass_;
      }
      const pass = enc.beginComputePass({ label: 'volumetric clouds', timestampWrites: tw('clouds') });
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, worldGroup);
      pass.setBindGroup(2, this.groups[this.cur]);
      pass.setPipeline(this.pipe);
      pass.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
      pass.end();
    }
  }

  /** For the perf panel: how the clouds are being marched. */
  describe() {
    return `clouds march ${this.w}×${this.h} (1/${this.scale.toFixed(1)} of the frame) · ${this.interleave ? 'interleaved' : 'every pixel'} · ${this.sunMapOn ? 'sun map' : 'no sun map'} · steps ×${this.quality}`;
  }

  private sunMapPass(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, worldGroup: GPUBindGroup, tw: (label: string) => GPUComputePassTimestampWrites | undefined) {
    const mp = enc.beginComputePass({ label: 'clouds sun map', timestampWrites: tw('cloud map') });
    mp.setPipeline(this.mapPipe);
    mp.setBindGroup(0, frameGroup);
    mp.setBindGroup(1, worldGroup);
    mp.setBindGroup(2, this.mapGroup);
    mp.dispatchWorkgroups(SM_N / 8, SM_N / 8);
    mp.end();
  }

  dispose() {
    for (const t of this.tex) t.destroy();
    this.sunMap.destroy();
    this.params.destroy();
  }
}
