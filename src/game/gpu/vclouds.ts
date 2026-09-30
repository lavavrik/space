/**
 * Volumetric clouds (docs/clouds.md; vclouds.wgsl): a half-resolution (at most MAX_PIXELS) compute pass over the frame,
 * after the scene (it reads the scene's depth), for the one clouded world you're near. `composite`
 * then lays its result over the resolved frame (scene × transmittance + cloud light), before the
 * particles are drawn over that (gpu/particles.ts drawOver), the bloom and the tone map.
 */
import { THREE } from '../lib/three';
import { VCLOUDS_WGSL } from './shaders';

/** Laying the result over the frame: frame × a + rgb (a blend), upsampled depth-aware (below). */
const COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var clouds: texture_2d<f32>;
@group(0) @binding(1) var sceneDepth: texture_depth_multisampled_2d;
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Depth-aware upsampling: a soft 3 × 3 over the half-res march (what's left of its jitter after
  // the temporal blend would show as static inside the clouds), each texel weighted by how alike
  // the scene's depth is where it was marched and here. Blurred across an edge (the far terrain's
  // against the sky), sky clouds bled onto the ground and the ground's onto the sky, a soft, low-res
  // band all along the horizon.
  let full = vec2f(textureDimensions(sceneDepth));
  let half = vec2i(textureDimensions(clouds));
  let k = full / vec2f(half);
  let dc = textureLoad(sceneDepth, vec2i(pos.xy), 0);
  let c = pos.xy / k - 0.5;
  let base = vec2i(floor(c + 0.5));
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let t = clamp(base + vec2i(x, y), vec2i(0), half - 1);
      let tp = (vec2f(t) + 0.5) * k; // (where it was marched: vclouds.wgsl full)
      let dt = textureLoad(sceneDepth, vec2i(min(tp, full - 1.0)), 0);
      let g = (2.0 - f32(abs(x))) * (2.0 - f32(abs(y)));
      let same = exp(-abs(dt - dc) / (0.03 * max(dt, dc) + 1e-7));
      let w = g * (same + 1e-3);
      sum += textureLoad(clouds, t, 0) * w;
      wsum += w;
    }
  }
  return sum / wsum;
}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** vclouds.wgsl VParams: a mat4, a vec4, 8 floats. */
const PARAM_BYTES = 64 + 16 + 32;
/** The march's resolution: half the frame's, but at most this many pixels (~4 ms at 1200 × 750 on an M-series GPU was too much). */
const MAX_PIXELS = 400e3;

export class VolumetricClouds {
  private readonly pipe: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly params: GPUBuffer;
  private readonly data = new Float32Array(PARAM_BYTES / 4);
  /** Ping-pong: this frame's result and last frame's (the history it's blended with). */
  private tex: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private readonly compPipe: GPURenderPipeline;
  private compGroups: GPUBindGroup[] = [];
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
      ],
    });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.pipe = device.createComputePipeline({
      label: 'volumetric clouds',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, worldLayout, this.layout] }),
      compute: { module: device.createShaderModule({ label: 'volumetric clouds', code: VCLOUDS_WGSL }), entryPoint: 'main' },
    });
    const cm = device.createShaderModule({ label: 'clouds composite', code: COMPOSITE_WGSL });
    this.compPipe = device.createRenderPipeline({
      label: 'clouds composite',
      layout: 'auto',
      vertex: { module: cm, entryPoint: 'vs' },
      // frame × a + rgb
      fragment: { module: cm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
    });
    this.params = device.createBuffer({ label: 'volumetric clouds', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** A new frame size: `depth` is the scene's (multisampled) depth. */
  resize(depth: GPUTexture, W: number, H: number) {
    for (const t of this.tex) t.destroy();
    const k = Math.min(0.5, Math.sqrt(MAX_PIXELS / Math.max(1, W * H)));
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
        ],
      }),
    );
    this.compGroups = [0, 1].map((k) =>
      this.device.createBindGroup({
        layout: this.compPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.tex[k].createView() },
          { binding: 1, resource: depth.createView() },
        ],
      }),
    );
    this.hasPrev = false;
  }

  /** Lay this frame's clouds over the frame (a pass on the resolved frame, after dispatch). */
  composite(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.compPipe);
    pass.setBindGroup(0, this.compGroups[this.cur]);
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
    d.set([this.w, this.h, on, this.n++, this.near, this.scale, lift, 0], 20);
    this.device.queue.writeBuffer(this.params, 0, d);
    this.prevVP.set(vp.elements);
    this.prevRel.copy(rel);
    this.prevQ.copy(q);
    this.prevGroup = worldGroup;
    this.hasPrev = true;
    const pass = enc.beginComputePass({ label: 'volumetric clouds', timestampWrites: tw('clouds') });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, worldGroup);
    pass.setBindGroup(2, this.groups[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
    pass.end();
  }

  dispose() {
    for (const t of this.tex) t.destroy();
    this.params.destroy();
  }
}
