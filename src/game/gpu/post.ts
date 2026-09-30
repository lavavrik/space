/**
 * Post-processing (docs/post.md): the bloom chain (bloom.wgsl) and the final pass's settings
 * (tonemap.wgsl: FTL zoom blur, the volumetric clouds, bloom, the star's lens flare, tone map).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { BLOOM_WGSL } from './shaders';

const LEVELS = 6;
/** Light over this (display units) blooms. */
const THRESHOLD = 2.0;
export const BLOOM_K = 0.25;
/**
 * Each coarser level's share as it's added into the next finer one (so the widest level adds
 * 0.55⁵ ≈ 5%): added at full weight, a wide bright source (the horizon's haze at low altitude)
 * bloomed as much through the coarsest levels as the finest, a white glow rising far into the sky.
 */
const UP_W = 0.55;
export const FLARE_K = 0.4;

export class Bloom {
  private readonly down: GPURenderPipeline;
  private readonly up: GPURenderPipeline;
  private readonly samp: GPUSampler;
  private tex: GPUTexture[] = [];
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];
  private bufs: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: 'bloom', code: BLOOM_WGSL });
    const target = (blend?: GPUBlendState): GPUColorTargetState => ({ format: 'rgba16float', blend });
    this.down = device.createRenderPipeline({ label: 'bloom down', layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fsDown', targets: [target()] } });
    this.up = device.createRenderPipeline({
      label: 'bloom up',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fsUp', targets: [target({ color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } })] },
    });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  /** A new frame size; `src` is the resolved frame. */
  resize(src: GPUTexture, W: number, H: number) {
    for (const t of this.tex) t.destroy();
    for (const b of this.bufs) b.destroy();
    this.tex = [];
    this.bufs = [];
    let w = W,
      h = H;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      this.tex.push(this.device.createTexture({ label: `bloom ${i}`, size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    }
    const params = (srcW: number, srcH: number, first: boolean, k = THRESHOLD) => {
      const b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, new Float32Array([1 / srcW, 1 / srcH, k, first ? 1 : 0]));
      this.bufs.push(b);
      return b;
    };
    // down i: from the frame (i = 0) or level i − 1, into level i
    this.downGroups = this.tex.map((_, i) => {
      const s = i === 0 ? src : this.tex[i - 1];
      return this.device.createBindGroup({
        layout: this.down.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: s.createView() },
          { binding: 1, resource: this.samp },
          { binding: 2, resource: { buffer: params(s.width, s.height, i === 0) } },
        ],
      });
    });
    // up i: from level i + 1, added into level i
    this.upGroups = this.tex.slice(0, -1).map((_, i) => {
      const s = this.tex[i + 1];
      return this.device.createBindGroup({
        layout: this.up.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: s.createView() },
          { binding: 1, resource: this.samp },
          { binding: 2, resource: { buffer: params(s.width, s.height, false, UP_W) } },
        ],
      });
    });
  }

  /** The chain for this frame (after the scene is resolved). */
  render(enc: GPUCommandEncoder, tw: (label: string) => GPURenderPassTimestampWrites | undefined) {
    const pass = (view: GPUTextureView, load: boolean, pipe: GPURenderPipeline, group: GPUBindGroup, first: boolean) => {
      const p = enc.beginRenderPass({
        label: 'bloom',
        colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: first ? tw('bloom') : undefined,
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, group);
      p.draw(3);
      p.end();
    };
    this.tex.forEach((t, i) => pass(t.createView(), false, this.down, this.downGroups[i], i === 0));
    for (let i = LEVELS - 2; i >= 0; i--) pass(this.tex[i].createView(), true, this.up, this.upGroups[i], false);
  }

  /** The bloom (half the frame's size). */
  get views() {
    return { bloom: this.tex[0].createView(), samp: this.samp };
  }

  dispose() {
    for (const t of this.tex) t.destroy();
    for (const b of this.bufs) b.destroy();
  }
}

/**
 * The final pass's settings for this frame: FTL's zoom blur toward the point you're heading for,
 * as strong as your speed (from ~1,000 to ~1,000,000 km/s), the bloom and flare strengths, and
 * the canvas's size (CW × CH px).
 */
export function postParams(g: Game, vp: THREE.Matrix4, clouds: boolean, CW: number, CH: number) {
  const out = new Float32Array(12);
  let blur = 0;
  let fx = 0.5,
    fy = 0.5,
    side = 1;
  if (g.ship.mode === 'ftl' && !g.jump) {
    blur = 0.1 * THREE.MathUtils.clamp((Math.log10(Math.max(g.curSpeed, 1)) - 6) / 3, 0, 1); // (a hint of it: full strength was too much)
    const d = new THREE.Vector4(g.ship.travelDir.x, g.ship.travelDir.y, g.ship.travelDir.z, 0).applyMatrix4(vp);
    if (Math.abs(d.w) > 1e-6) {
      side = d.w > 0 ? 1 : -1;
      fx = (d.x / d.w) * 0.5 + 0.5;
      fy = 0.5 - (d.y / d.w) * 0.5;
    }
  }
  out.set([clouds ? 1 : 0, BLOOM_K, FLARE_K, blur, fx, fy, side, CW]);
  out[11] = CH; // (the canvas's size: the scene may be rendered smaller, gpu/dynres.ts)
  // the star on screen, for its lens flare
  const r = g.cur.star.pos.clone().sub(g.ship.pos);
  const q = new THREE.Vector4(r.x, r.y, r.z, 0).applyMatrix4(vp);
  if (q.w > 0) out.set([(q.x / q.w) * 0.5 + 0.5, 0.5 - (q.y / q.w) * 0.5, 1], 8);
  return out;
}
