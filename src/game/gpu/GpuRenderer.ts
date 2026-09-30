/**
 * The WebGPU renderer (docs/webgpu.md), being built layer by layer beside the WebGL one
 * (render/SceneRenderer.ts). So far: the core (HDR frame, reversed-Z depth, camera-relative view,
 * tone mapping), the sky (the Milky Way and the stars) and the system's bodies (gpu/worlds.ts: the star,
 * planets, skies, cloud decks, ring discs, dots). Everything else is still WebGL-only.
 *
 * A frame:
 *   1. the scene into `hdr` (rgba16float, 4× MSAA, resolved into `resolved`), with a depth32float
 *      buffer, reversed-Z (cleared to 0, `greater` passes), infinite far plane;
 *   2. the tone map from `resolved` to the canvas.
 * Positions are camera-relative (world − ship), in doubles on the CPU, as in the WebGL renderer.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { GameRenderer, ViewInfo } from '../render/api';
import { skyColor, skyLook } from '../sim/hyperspace';
import type { Body, CurrentSystem, StarSystem, Station } from '../types';
import type { Gpu } from './device';
import { SKY_BAKE_WGSL, SKY_WGSL, STARS_WGSL, TONEMAP_WGSL } from './shaders';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES, WorldsLayer } from './worlds';

/** Near plane (m): with reversed-Z and 32-bit float depth, precision barely depends on it. */
const NEAR = 0.5;
/** Most pixels rendered per frame, as the WebGL renderer (render/SceneRenderer.ts MAX_RENDER_PIXELS). */
const MAX_RENDER_PIXELS = 5e6;
/** The baked Milky Way cube map's face size. */
const SKY_CUBE = 1024;
/** Bytes in the per-frame uniform block (frame.wgsl Frame): two mat4 + 12 floats, padded. */
const FRAME_BYTES = 192;

export class GpuRenderer implements GameRenderer {
  readonly kind = 'webgpu' as const;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly frameGroup: GPUBindGroup;
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly skyPipe: GPURenderPipeline;
  private readonly skyGroup: GPUBindGroup;
  private readonly starsPipe: GPURenderPipeline;
  private readonly tonePipe: GPURenderPipeline;
  private readonly worlds: WorldsLayer;
  private starBuf: GPUBuffer | null = null;
  private starCount = 0;
  private hdr!: GPUTexture;
  private resolved!: GPUTexture;
  private depth!: GPUTexture;
  private toneGroup!: GPUBindGroup;
  private W = 1;
  private H = 1;
  private PR = 1;
  private readonly views = new Map<Body | Station, ViewInfo>();
  private readonly proj = new THREE.Matrix4();
  private readonly viewM = new THREE.Matrix4();
  private readonly rot = new THREE.Matrix4();
  private readonly vp = new THREE.Matrix4();

  constructor(
    readonly canvas: HTMLCanvasElement,
    gpu: Gpu,
  ) {
    const { device, format } = gpu;
    this.device = device;
    this.context = canvas.getContext('webgpu')!;
    this.context.configure({ device, format, alphaMode: 'opaque' });

    this.frameBuf = device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.frameGroup = device.createBindGroup({ layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });

    // the scene's passes all draw into the HDR target: no depth test for the sky and stars
    const hdrTarget: GPUColorTargetState = { format: HDR_FORMAT };
    const additive: GPUColorTargetState = {
      format: HDR_FORMAT,
      blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
    };
    const noDepth: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' };

    // sky: the baked cube map
    const skyTex = this.bakeSky();
    const skyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.skyGroup = device.createBindGroup({
      layout: skyLayout,
      entries: [
        { binding: 0, resource: skyTex.createView({ dimension: 'cube' }) },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
    const skyModule = device.createShaderModule({ label: 'sky', code: SKY_WGSL });
    this.skyPipe = device.createRenderPipeline({
      label: 'sky',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, skyLayout] }),
      vertex: { module: skyModule, entryPoint: 'vs' },
      fragment: { module: skyModule, entryPoint: 'fs', targets: [hdrTarget] },
      depthStencil: noDepth,
      multisample: { count: SAMPLES },
    });

    // stars: instanced quads, one per system in sight
    const starsModule = device.createShaderModule({ label: 'stars', code: STARS_WGSL });
    this.starsPipe = device.createRenderPipeline({
      label: 'stars',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] }),
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
      fragment: { module: starsModule, entryPoint: 'fs', targets: [additive] },
      depthStencil: noDepth,
      multisample: { count: SAMPLES },
    });

    // tone map to the canvas
    const toneModule = device.createShaderModule({ label: 'tonemap', code: TONEMAP_WGSL });
    this.tonePipe = device.createRenderPipeline({
      label: 'tonemap',
      layout: 'auto',
      vertex: { module: toneModule, entryPoint: 'vs' },
      fragment: { module: toneModule, entryPoint: 'fs', targets: [{ format }] },
    });

    this.worlds = new WorldsLayer(device, this.frameLayout);
  }

  /** The Milky Way into a cube map, once (skyBake.wgsl): a pass per face. */
  private bakeSky() {
    const { device } = this;
    const tex = device.createTexture({
      label: 'sky cube',
      size: [SKY_CUBE, SKY_CUBE, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const module = device.createShaderModule({ label: 'sky bake', code: SKY_BAKE_WGSL });
    const pipe = device.createRenderPipeline({
      label: 'sky bake',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    for (let face = 0; face < 6; face++) {
      const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const u = new ArrayBuffer(16);
      new Uint32Array(u, 0, 1)[0] = face;
      new Float32Array(u, 4, 3).set([SKY_CUBE, SKY_CUBE / (Math.PI / 2), 0]);
      device.queue.writeBuffer(buf, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: tex.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }));
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    return tex;
  }

  /** Every other system within sight as a star: direction, colour × intensity, size (render/SceneRenderer.ts buildSysStars). */
  setSystem(cur: CurrentSystem, sky: StarSystem[]) {
    this.views.clear();
    const others = sky.filter((s) => s.id !== cur.sys.id);
    const data = new Float32Array(Math.max(1, others.length) * 7);
    others.forEach((s, i) => {
      const d = s.pos.clone().sub(cur.sys.pos);
      const { size, k } = skyLook(s.star.L, d.length());
      d.normalize();
      const c = skyColor(s.star.color, k);
      data.set([d.x, d.y, d.z, c.r, c.g, c.b, size], i * 7);
    });
    this.starBuf?.destroy();
    this.starBuf = this.device.createBuffer({ label: 'stars', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.starBuf, 0, data);
    this.starCount = others.length;
    this.worlds.setSystem(cur);
  }

  /** As the WebGL renderer: up to 1.5× the CSS resolution, at most MAX_RENDER_PIXELS. */
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
    this.depth = this.device.createTexture({ label: 'depth', size, format: DEPTH_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.toneGroup = this.device.createBindGroup({ layout: this.tonePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.resolved.createView() }] });
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
    // per-frame uniforms
    const P = this.projection(g.fov);
    this.rot.makeRotationFromQuaternion(ship.q);
    this.viewM.copy(this.rot).invert();
    this.vp.multiplyMatrices(P, this.viewM);
    const f = this.frameData;
    f.set(this.vp.elements, 0);
    f.set(this.rot.elements, 16);
    f.set([this.W, this.H, P.elements[0], P.elements[5], this.PR, g.simTime, 1, 1, 1], 32);
    device.queue.writeBuffer(this.frameBuf, 0, f);
    this.updateViews(g);
    this.worlds.update(g);

    const enc = device.createCommandEncoder({ label: 'frame' });
    this.worlds.bake(enc, this.frameGroup);
    const pass = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.hdr.createView(), resolveTarget: this.resolved.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0 },
    });
    pass.setBindGroup(0, this.frameGroup);
    // the Milky Way, then the stars over it
    pass.setPipeline(this.skyPipe);
    pass.setBindGroup(1, this.skyGroup);
    pass.draw(3);
    if (this.starBuf && this.starCount) {
      pass.setPipeline(this.starsPipe);
      pass.setVertexBuffer(0, this.starBuf);
      pass.draw(6, this.starCount);
    }
    // the system's bodies: surfaces, then the transparent layers
    this.worlds.drawOpaque(pass);
    this.worlds.drawTransparent(pass);
    pass.end();

    const tone = enc.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    tone.setPipeline(this.tonePipe);
    tone.setBindGroup(0, this.toneGroup);
    tone.draw(3);
    tone.end();
    device.queue.submit([enc.finish()]);
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
    this.starBuf?.destroy();
    this.worlds.dispose();
    this.hdr?.destroy();
    this.resolved?.destroy();
    this.depth?.destroy();
    this.frameBuf.destroy();
    this.context.unconfigure();
  }
}
