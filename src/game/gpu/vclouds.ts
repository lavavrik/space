/**
 * Volumetric clouds (docs/clouds.md; vclouds.wgsl): a half-resolution (at most MAX_PIXELS) compute pass over the frame,
 * after the scene (it reads the scene's depth), for the one clouded world you're near. The tone map
 * lays its result over the frame (scene × transmittance + cloud light).
 */
import { THREE } from '../lib/three';
import { VCLOUDS_WGSL } from './shaders';

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
  private cur = 0;
  private readonly samp: GPUSampler;
  /** Last frame's view-projection and camera position (doubles), for the reprojection. */
  private readonly prevVP = new Float32Array(16);
  private readonly prevPos = new THREE.Vector3();
  private hasPrev = false;
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
    this.hasPrev = false;
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
   * frame's view-projection and `pos` the camera's position (for next frame's reprojection).
   */
  dispatch(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, worldGroup: GPUBindGroup | null, on: number, vp: THREE.Matrix4, pos: THREE.Vector3, tw: (label: string) => GPUComputePassTimestampWrites | undefined) {
    if (!worldGroup || on <= 0 || !this.groups.length) {
      this.hasPrev = false;
      return;
    }
    this.cur = 1 - this.cur;
    const d = this.data;
    d.set(this.prevVP, 0);
    // how far the camera moved (a camera-relative point then = now's + this)
    d.set([pos.x - this.prevPos.x, pos.y - this.prevPos.y, pos.z - this.prevPos.z, this.hasPrev ? 1 : 0], 16);
    d.set([this.w, this.h, on, this.n++, this.near, this.scale], 20);
    this.device.queue.writeBuffer(this.params, 0, d);
    this.prevVP.set(vp.elements);
    this.prevPos.copy(pos);
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
