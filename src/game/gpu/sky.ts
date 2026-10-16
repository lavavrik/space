/**
 * The sky in WebGPU (docs/webgpu.md phases 1 and 6): the Milky Way baked once into a cube map, the
 * periscope's sharper patch re-baked for the zoomed view (at 100× a cube texel spans ~7 screen
 * pixels, far too coarse), and every other system in sight as a star (instanced quads).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { skyColor, skyLook } from '../sim/hyperspace';
import { pairLight } from '../universe/binary';
import type { CurrentSystem, StarSystem } from '../types';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { SKY_BAKE_WGSL, SKY_WGSL, STARS_WGSL } from './shaders';

/** The baked Milky Way cube map's face size. */
const SKY_CUBE = 1024;
/** The patch: at this fraction of the render resolution. */
const PATCH_SCALE = 0.5;
/** A new patch crossfades from the last over this long (ms). */
const CROSSFADE = 150;
/** skyBake.wgsl Bake: 4 words, a mat4, 4 floats. */
const BAKE_BYTES = 16 + 64 + 16;
/** sky.wgsl Patch: two mat4, 4 floats. */
const PATCH_BYTES = 128 + 16;

interface Patch {
  tex: [GPUTexture, GPUTexture];
  cur: number;
  w: number;
  h: number;
  q: THREE.Quaternion;
  zoom: number;
  bakedAt: number;
}

export class SkyLayer {
  private readonly bakePipe: GPURenderPipeline;
  private readonly skyPipe: GPURenderPipeline;
  readonly starsPipe: GPURenderPipeline;
  private readonly skyLayout: GPUBindGroupLayout;
  private readonly cube: GPUTexture;
  private readonly samp: GPUSampler;
  /** The baked Milky Way, for what's bent off screen round the black hole (gpu/blackhole.ts). */
  get cubeView() {
    return this.cube.createView({ dimension: 'cube' });
  }
  private readonly none: GPUTexture;
  private readonly patchBuf: GPUBuffer;
  private readonly patchData = new Float32Array(PATCH_BYTES / 4);
  private readonly bakeBuf: GPUBuffer;
  private group!: GPUBindGroup;
  private patch: Patch | null = null;
  private starBuf: GPUBuffer | null = null;
  private starCount = 0;
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly vpM = new THREE.Matrix4();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const FS = GPUShaderStage.FRAGMENT;
    const bakeModule = device.createShaderModule({ label: 'sky bake', code: SKY_BAKE_WGSL });
    this.bakePipe = device.createRenderPipeline({
      label: 'sky bake',
      layout: 'auto',
      vertex: { module: bakeModule, entryPoint: 'vs' },
      fragment: { module: bakeModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    this.bakeBuf = device.createBuffer({ label: 'sky bake', size: BAKE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cube = device.createTexture({ label: 'sky cube', size: [SKY_CUBE, SKY_CUBE, 6], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    for (let face = 0; face < 6; face++) this.bake(this.cube.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }), face, SKY_CUBE, SKY_CUBE / (Math.PI / 2));
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.none = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.patchBuf = device.createBuffer({ label: 'sky patch', size: PATCH_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.skyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FS, texture: { viewDimension: 'cube' } },
        { binding: 1, visibility: FS, sampler: {} },
        { binding: 2, visibility: FS, texture: {} },
        { binding: 3, visibility: FS, texture: {} },
        { binding: 4, visibility: FS, buffer: { type: 'uniform' } },
      ],
    });
    this.bindPatch(this.none, this.none);
    const noDepth: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' };
    const skyModule = device.createShaderModule({ label: 'sky', code: SKY_WGSL });
    this.skyPipe = device.createRenderPipeline({
      label: 'sky',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.skyLayout] }),
      vertex: { module: skyModule, entryPoint: 'vs' },
      fragment: { module: skyModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      depthStencil: noDepth,
      multisample: { count: SAMPLES },
    });
    const starsModule = device.createShaderModule({ label: 'stars', code: STARS_WGSL });
    this.starsPipe = device.createRenderPipeline({
      label: 'stars',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: {
        module: starsModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 7 * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: starsModule,
        entryPoint: 'fs',
        targets: [{ format: HDR_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
      },
      depthStencil: noDepth,
      multisample: { count: SAMPLES },
    });
  }

  /** The Milky Way (skyBake.wgsl) into `view`: a cube face (0…5), or the patch (6) with the camera set. */
  private bake(view: GPUTextureView, face: number, size: number, pxPerRad: number, rot?: THREE.Matrix4, tanHalf?: [number, number], px?: [number, number]) {
    const { device } = this;
    const u = new ArrayBuffer(BAKE_BYTES);
    new Uint32Array(u, 0, 1)[0] = face;
    const f = new Float32Array(u);
    f.set([size, pxPerRad], 1);
    if (rot) f.set(rot.elements, 4);
    if (tanHalf) f.set(tanHalf, 20);
    if (px) f.set(px, 22);
    device.queue.writeBuffer(this.bakeBuf, 0, u);
    const enc = device.createCommandEncoder({ label: 'sky bake' });
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.bakePipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: this.bakePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.bakeBuf } }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  private bindPatch(cur: GPUTexture, prev: GPUTexture) {
    this.group = this.device.createBindGroup({
      layout: this.skyLayout,
      entries: [
        { binding: 0, resource: this.cube.createView({ dimension: 'cube' }) },
        { binding: 1, resource: this.samp },
        { binding: 2, resource: cur.createView() },
        { binding: 3, resource: prev.createView() },
        { binding: 4, resource: { buffer: this.patchBuf } },
      ],
    });
  }

  /** Every other system within sight as a star: direction, colour × intensity, size (buildSysStars). */
  setSystem(cur: CurrentSystem, sky: StarSystem[]) {
    const others = sky.filter((s) => s.id !== cur.sys.id);
    const data = new Float32Array(Math.max(1, others.length) * 7);
    others.forEach((s, i) => {
      const d = s.pos.clone().sub(cur.sys.pos);
      const pl = pairLight(s); // (a pair: one point, both stars' light)
      const { size, k } = skyLook(pl.L, d.length(), !!s.star.hole);
      d.normalize();
      const c = skyColor(pl.color, k);
      data.set([d.x, d.y, d.z, c.r, c.g, c.b, size], i * 7);
    });
    this.starBuf?.destroy();
    this.starBuf = this.device.createBuffer({ label: 'stars', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.starBuf, 0, data);
    this.starCount = others.length;
  }

  /**
   * Through the periscope (zoom from 2×), re-bake the patch for the view: every frame while the zoom
   * moves (each layer's detail is set at bake time), then only when the view turns by a tenth of the
   * field, crossfading from the last. `W`, `H`: the render size.
   */
  update(g: Game, W: number, H: number) {
    const z = g.zoom.cur;
    const u = this.patchData;
    if (z < 2) {
      u[32] = 0;
      if (this.patch) this.patch.zoom = 0; // start fresh next time
      this.device.queue.writeBuffer(this.patchBuf, 0, u);
      return;
    }
    const w = Math.max(64, Math.round(W * PATCH_SCALE)),
      h = Math.max(64, Math.round(H * PATCH_SCALE));
    let p = this.patch;
    if (!p || p.w !== w || p.h !== h) {
      p?.tex.forEach((t) => t.destroy());
      const mk = () => this.device.createTexture({ label: 'sky patch', size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      p = this.patch = { tex: [mk(), mk()], cur: 0, w, h, q: new THREE.Quaternion(), zoom: 0, bakedAt: 0 };
    }
    const now = performance.now();
    const fovRad = (g.fov * Math.PI) / 180;
    const first = !p.zoom;
    const moving = Math.abs(z / (g.zoom.on ? g.zoom.mag : 1) - 1) > 0.002;
    const stale = first || moving || z !== p.zoom || p.q.angleTo(g.ship.q) > fovRad * 0.1;
    if (stale && (first || moving || now - p.bakedAt > CROSSFADE)) {
      const cam = this.cam;
      // zooming out, the view is about to widen: bake a wider margin so the edges stay covered
      cam.fov = g.fov * (z < p.zoom ? 2 : 1.3);
      cam.aspect = w / h;
      cam.near = 0.1;
      cam.far = 1000;
      cam.quaternion.copy(g.ship.q);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const ty = Math.tan(((cam.fov / 2) * Math.PI) / 180);
      const next = 1 - p.cur;
      // (the detail layers fade in by the view's own resolution, not the bake's: by the bake's, the
      // wider margin while zooming out dropped them, and they popped back when the zoom stopped and
      // the patch was baked again at the usual margin, SPACE-34)
      const viewPxPerRad = h / 2 / Math.tan((g.fov * Math.PI) / 360);
      this.bake(p.tex[next].createView(), 6, h, viewPxPerRad, new THREE.Matrix4().makeRotationFromQuaternion(g.ship.q), [ty * cam.aspect, ty], [w, h]);
      const vp = this.vpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      // the old patch becomes the one we fade from
      u.set(first ? vp.elements : u.subarray(0, 16), 16);
      u.set(vp.elements, 0);
      this.bindPatch(p.tex[next], first ? p.tex[next] : p.tex[p.cur]);
      p.cur = next;
      p.q.copy(g.ship.q);
      p.zoom = z;
      p.bakedAt = moving ? now - CROSSFADE : now; // per-frame bakes don't crossfade
    }
    u[33] = Math.min(1, (now - p.bakedAt) / CROSSFADE);
    u[32] = THREE.MathUtils.smoothstep(z, 2, 4);
    this.device.queue.writeBuffer(this.patchBuf, 0, u);
  }

  /** The Milky Way, then (outside hyperspace) the stars over it. */
  draw(pass: GPURenderPassEncoder, stars: boolean) {
    pass.setPipeline(this.skyPipe);
    pass.setBindGroup(1, this.group);
    pass.draw(3);
    if (stars && this.starBuf && this.starCount) {
      pass.setPipeline(this.starsPipe);
      pass.setVertexBuffer(0, this.starBuf);
      pass.draw(6, this.starCount);
    }
  }

  dispose() {
    this.cube.destroy();
    this.none.destroy();
    this.patch?.tex.forEach((t) => t.destroy());
    this.starBuf?.destroy();
    this.patchBuf.destroy();
    this.bakeBuf.destroy();
  }
}
