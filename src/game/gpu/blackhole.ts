/**
 * The galactic core's black hole (docs/blackhole.md): a pass over the resolved frame, after the
 * scene and before the exposure meter and bloom (so the disk blooms), that traces each pixel's light
 * through the hole's field (blackhole.wgsl). It reads a copy of the frame and its depth, and the
 * Milky Way's cube for rays bent off screen. It only covers the lens's footprint on screen (a scissor
 * rect), the whole view once you're inside it.
 */
import type { Game } from '../Game';
import { C } from '../constants';
import { THREE } from '../lib/three';
import type { Star } from '../types';
import { HDR_FORMAT } from './formats';
import { BLACKHOLE_WGSL } from './shaders';

/** The lens's radius (Rs): rays are traced inside it, their bend eased out toward its edge. */
const LENS_R = 100;
/** The disk turns this many times faster than it really would (one orbit at its inner edge: ~15 min, not 13 h). */
const DISK_SPEEDUP = 50;
/** The disk's brightness at its hottest (display units, before Doppler beaming). */
const DISK_K = 6;
/** hole uniform: 4 vec4. */
const HOLE_BYTES = 64;

export class BlackHolePass {
  private readonly pipe: GPURenderPipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly buf: GPUBuffer;
  private readonly samp: GPUSampler;
  private readonly data = new Float32Array(HOLE_BYTES / 4);
  private copy: GPUTexture | null = null;
  private group: GPUBindGroup | null = null;
  /** This system's black hole, if it has one. */
  private hole: Star | null = null;
  /** This frame's scissor rect (px), or null when the lens is off screen. */
  private rect: [number, number, number, number] | null = null;
  private readonly rel = new THREE.Vector3();
  private readonly v4 = new THREE.Vector4();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    private readonly skyView: GPUTextureView,
  ) {
    const FS = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'black hole',
      entries: [
        { binding: 0, visibility: FS, buffer: {} },
        { binding: 1, visibility: FS, texture: {} },
        { binding: 2, visibility: FS, sampler: {} },
        { binding: 3, visibility: FS, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 4, visibility: FS, texture: { viewDimension: 'cube' } },
      ],
    });
    const module = device.createShaderModule({ label: 'black hole', code: BLACKHOLE_WGSL });
    this.pipe = device.createRenderPipeline({
      label: 'black hole',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
    });
    this.buf = device.createBuffer({ label: 'black hole', size: HOLE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** A new system: its black hole, if any. */
  setSystem(stars: Star[]) {
    this.hole = stars.find((s) => !!s.hole) ?? null;
  }

  /** A new frame size: the frame's copy, and the bind group over it and the depth. */
  resize(depth: GPUTexture, W: number, H: number) {
    this.copy?.destroy();
    this.copy = this.device.createTexture({ label: 'black hole src', size: [W, H], format: HDR_FORMAT, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    this.group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.buf } },
        { binding: 1, resource: this.copy.createView() },
        { binding: 2, resource: this.samp },
        { binding: 3, resource: depth.createView() },
        { binding: 4, resource: this.skyView },
      ],
    });
  }

  /**
   * Per frame: the uniforms and the footprint. `vp` is the camera-relative view-projection, `near`
   * the projection's near plane (depth = near / distance). Returns whether the pass runs.
   */
  update(g: Game, vp: THREE.Matrix4, W: number, H: number, near: number) {
    const h = this.hole;
    this.rect = null;
    if (!h?.hole) return false;
    const { rs, diskIn, diskOut, diskAxis } = h.hole;
    const rel = this.rel.subVectors(g.ship.pos, h.pos); // (the camera, from the hole)
    const d = rel.length();
    const R = LENS_R * rs;
    const inside = d < R * 1.02;
    // the footprint: the lens's bounding cube's corners on screen (all of it if one's behind you)
    if (inside) this.rect = [0, 0, W, H];
    else {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        const p = this.v4.set(k & 1 ? R : -R, k & 2 ? R : -R, k & 4 ? R : -R, 1);
        p.set(p.x - rel.x, p.y - rel.y, p.z - rel.z, 1).applyMatrix4(vp);
        if (p.w <= 0) {
          // (a corner behind you: the whole view)
          x0 = y0 = -1;
          x1 = y1 = 1;
          break;
        }
        p.divideScalar(p.w);
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      const px0 = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * W)),
        px1 = Math.min(W, Math.ceil((x1 * 0.5 + 0.5) * W)),
        py0 = Math.max(0, Math.floor((0.5 - y1 * 0.5) * H)),
        py1 = Math.min(H, Math.ceil((0.5 - y0 * 0.5) * H));
      if (px1 - px0 < 1 || py1 - py0 < 1) return false;
      this.rect = [px0, py0, px1 - px0, py1 - py0];
    }
    const f = this.data;
    f.set([rel.x / rs, rel.y / rs, rel.z / rs, rs], 0);
    f.set([diskAxis.x, diskAxis.y, diskAxis.z, diskIn / rs], 4);
    // (the disk's clock in Rs/c, wrapped well short of where f32 loses the turn)
    const clock = ((g.simTime * C) / rs) * DISK_SPEEDUP;
    f.set([diskOut / rs, LENS_R, clock % 1e5, DISK_K], 8);
    // what's nearer than this is in front of the hole: the lens's near side, or halfway there from inside it
    const frontDist = Math.max(d - 40 * rs, d * 0.5);
    f.set([near / frontDist, inside ? 1 : 0, 0, 0], 12);
    this.device.queue.writeBuffer(this.buf, 0, f);
    return true;
  }

  /** After the scene: the frame copied, then the lensed footprint drawn back over it. */
  encode(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, resolved: GPUTexture, W: number, H: number, ts?: GPURenderPassTimestampWrites) {
    if (!this.rect || !this.group || !this.copy) return;
    enc.copyTextureToTexture({ texture: resolved }, { texture: this.copy }, [W, H]);
    const pass = enc.beginRenderPass({ label: 'black hole', colorAttachments: [{ view: resolved.createView(), loadOp: 'load', storeOp: 'store' }], timestampWrites: ts });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, this.group);
    pass.setScissorRect(...this.rect);
    pass.draw(3);
    pass.end();
  }

  dispose() {
    this.copy?.destroy();
    this.buf.destroy();
  }
}
