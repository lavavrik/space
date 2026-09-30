/**
 * The WebGPU renderer (docs/webgpu.md), built layer by layer beside the WebGL one
 * (render/SceneRenderer.ts):
 *   - the sky (gpu/sky.ts): the Milky Way, the periscope's patch, the stars;
 *   - the system's bodies (gpu/worlds.ts): the star, planets, terrain up close (gpu/terrain.ts),
 *     skies, cloud decks, rings and their rocks (gpu/rings.ts), dots for distant things;
 *   - stations (gpu/stations.ts), ships and effects (gpu/effects.ts), hyperspace (gpu/hyperspace.ts).
 *
 * A frame:
 *   1. compute: terrain chunks' bakes, the ring rocks' culling;
 *   2. the scene into `hdr` (rgba16float, 4× MSAA, resolved into `resolved`), with a depth32float
 *      buffer, reversed-Z (cleared to 0, `greater` passes), infinite far plane: sky, opaque things,
 *      then transparent ones;
 *   3. the tone map from `resolved` to the canvas.
 * Positions are camera-relative (world − ship), in doubles on the CPU, as in the WebGL renderer.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { GameRenderer, ViewInfo } from '../render/api';
import { FLOOD_K, HEAD_K, INT_K, SKY_K, WINDOW_K } from '../render/exposure';
import type { Body, CurrentSystem, StarSystem, Station } from '../types';
import type { Gpu } from './device';
import { EffectsLayer } from './effects';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { HyperspaceLayer } from './hyperspace';
import { TONEMAP_WGSL } from './shaders';
import { SkyLayer } from './sky';
import { StationsLayer } from './stations';
import { WorldsLayer } from './worlds';

/** Near plane (m): with reversed-Z and 32-bit float depth, precision barely depends on it. */
const NEAR = 0.5;
/** Most pixels rendered per frame, as the WebGL renderer (render/SceneRenderer.ts MAX_RENDER_PIXELS). */
const MAX_RENDER_PIXELS = 5e6;
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
  private readonly worlds: WorldsLayer;
  private readonly stations: StationsLayer;
  private readonly fx: EffectsLayer;
  private readonly hyper: HyperspaceLayer;
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
  private readonly head = new THREE.Vector3();

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
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    this.frameGroup = device.createBindGroup({ layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });

    // tone map to the canvas
    const toneModule = device.createShaderModule({ label: 'tonemap', code: TONEMAP_WGSL });
    this.tonePipe = device.createRenderPipeline({
      label: 'tonemap',
      layout: 'auto',
      vertex: { module: toneModule, entryPoint: 'vs' },
      fragment: { module: toneModule, entryPoint: 'fs', targets: [{ format }] },
    });

    this.sky = new SkyLayer(device, this.frameLayout);
    this.worlds = new WorldsLayer(device, this.frameLayout);
    this.stations = new StationsLayer(device, this.frameLayout, this.worlds.worldLayout);
    this.fx = new EffectsLayer(device, this.frameLayout);
    this.hyper = new HyperspaceLayer(device, this.frameLayout);
  }

  setSystem(cur: CurrentSystem, sky: StarSystem[]) {
    this.views.clear();
    this.sky.setSystem(cur, sky);
    this.worlds.setSystem(cur);
    this.stations.setSystem(cur, this.worlds);
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
    // in hyperspace: only the Milky Way and the real stars streaming past, no system scene
    const inTunnel = !!g.jump && g.jump.phase === 'tunnel';
    // per-frame uniforms
    const P = this.projection(g.fov);
    this.rot.makeRotationFromQuaternion(ship.q);
    this.viewM.copy(this.rot).invert();
    this.vp.multiplyMatrices(P, this.viewM);
    const f = this.frameData;
    f.set(this.vp.elements, 0);
    f.set(this.rot.elements, 16);
    f.set([this.W, this.H, P.elements[0], P.elements[5], this.PR, g.simTime, 1, 1, 1, HEAD_K, FLOOD_K, HEAD_K / INT_K], 32);
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
      this.fx.update(g, this.worlds, this.PR);
      this.worlds.flushDots();
    }

    const enc = device.createCommandEncoder({ label: 'frame' });
    if (!inTunnel) this.worlds.bake(enc, this.frameGroup);
    const pass = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.hdr.createView(), resolveTarget: this.resolved.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0 },
    });
    pass.setBindGroup(0, this.frameGroup);
    this.sky.draw(pass, !inTunnel);
    if (inTunnel) {
      pass.setPipeline(this.sky.starsPipe);
      this.hyper.drawHeads(pass);
      this.hyper.drawStreaks(pass);
    } else {
      // opaque things, then the transparent layers
      this.worlds.drawOpaque(pass);
      this.stations.drawOpaque(pass);
      this.fx.drawOpaque(pass);
      this.worlds.drawTransparent(pass, (p) => {
        this.stations.drawTransparent(p);
        this.fx.drawTransparent(p);
      });
    }
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
    this.sky.dispose();
    this.worlds.dispose();
    this.stations.dispose();
    this.fx.dispose();
    this.hyper.dispose();
    this.hdr?.destroy();
    this.resolved?.destroy();
    this.depth?.destroy();
    this.frameBuf.destroy();
    this.context.unconfigure();
  }
}
