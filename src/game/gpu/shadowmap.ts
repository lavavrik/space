/**
 * The shadow map for things near the camera (docs/shadows.md): three cascades, each an orthographic
 * view from the star centred on the camera, 300 m, 3 km and 30 km across… in half-width, into one
 * 2048² depth texture array. Ring rocks, other ships and stations cast into it (their `vsShadow`
 * vertex stages, drawn by their layers); rocks, ships, stations and the terrain up close read it
 * (frame.wgsl shadowAt).
 *
 * Each cascade's window is snapped to its texels in a frame fixed to the system (from the camera's
 * position in doubles), so shadows don't crawl as you move. Depth runs from EXTEND half-widths
 * toward the star (casters up there still shadow what's in the window) to one half-width beyond.
 *
 * A pair's second sun (docs/binaries.md) gets a second set of cascades (layers 3–5, frame.wgsl
 * shadowAt2), drawn only while its light here is over 1 % of the first's: a wide pair's far
 * companion by day isn't worth the passes.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { sunsAt, type Suns } from '../sim/starlight';

export const CASCADES = 3;
const SIZE = 2048;
const RADII = [300, 3000, 30000];
/** How far toward the star (in half-widths) casters can be and still shadow the window. */
const EXTEND = 4;
/** Suns with their own cascades: a pair's both. */
const LIGHTS = 2;
/** Bytes in frame.wgsl ShadowMap: 6 mat4 (each sun's cascades), 4 vec4. */
const UNIFORM_BYTES = LIGHTS * CASCADES * 64 + 4 * 16;
/** Where the vec4s start (floats), after the matrices. */
const V0 = LIGHTS * CASCADES * 16;
/** A second sun this much of the first's light, or less, casts no shadows of its own. */
const SECOND_MIN = 0.01;

export class ShadowMap {
  readonly texture: GPUTexture;
  readonly sampler: GPUSampler;
  readonly uniform: GPUBuffer;
  /** The shadow passes' group 0 (frame.wgsl Caster), one per cascade. */
  readonly casterLayout: GPUBindGroupLayout;
  private readonly casterBufs: GPUBuffer[] = [];
  private readonly casterGroups: GPUBindGroup[] = [];
  private readonly data = new Float32Array(UNIFORM_BYTES / 4);
  private readonly views: GPUTextureView[] = [];
  /** Whether shadows are drawn this frame, and the second sun's too. */
  on = false;
  on2 = false;
  private readonly suns: Suns = { s1: null as unknown as Suns['s1'], s2: null, c2: new THREE.Color() };
  /** The cascades' half-widths, for the casters to pick what's worth drawing into each. */
  readonly radii = RADII;
  private readonly x = new THREE.Vector3();
  private readonly y = new THREE.Vector3();
  private readonly z = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();

  constructor(private readonly device: GPUDevice) {
    this.texture = device.createTexture({
      label: 'shadow map',
      size: [SIZE, SIZE, LIGHTS * CASCADES],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (let c = 0; c < LIGHTS * CASCADES; c++) this.views.push(this.texture.createView({ dimension: '2d', baseArrayLayer: c, arrayLayerCount: 1 }));
    this.sampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.uniform = device.createBuffer({ label: 'shadow map', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.casterLayout = device.createBindGroupLayout({ entries: [{ binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    for (let c = 0; c < LIGHTS * CASCADES; c++) {
      const b = device.createBuffer({ label: `shadow cascade ${c}`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.casterBufs.push(b);
      this.casterGroups.push(device.createBindGroup({ layout: this.casterLayout, entries: [{ binding: 4, resource: { buffer: b } }] }));
    }
  }

  /** The depth state the casters' pipelines draw with (slope-scaled bias keeps grazing faces clean). */
  static depth: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 };

  /** This frame's cascades: `on` decides whether anything is drawn (no star-lit casters nearby: off). */
  update(g: Game, on: boolean) {
    const d = this.data;
    const { ship } = g;
    const suns = sunsAt(g.cur.stars, ship.pos, this.suns);
    this.on = on;
    this.on2 = on && !!suns.s2 && Math.max(suns.c2.r, suns.c2.g, suns.c2.b) > SECOND_MIN;
    d[V0 + 3] = this.on ? 1 : 0;
    d[V0 + 12] = this.on2 ? 1 : 0;
    if (this.on) this.lightCascades(ship.pos, suns.s1.pos, 0);
    if (this.on2) this.lightCascades(ship.pos, suns.s2!.pos, 1);
    d[V0 + 7] = SIZE;
    this.device.queue.writeBuffer(this.uniform, 0, d);
  }

  /** One sun's cascades (`k`: 0 the first sun, 1 a pair's second), seen from `star`. */
  private lightCascades(camPos: THREE.Vector3, star: THREE.Vector3, k: number) {
    const d = this.data;
    const ship = { pos: camPos };
    // light axes: z toward the star, x and y across
    const z = this.z.subVectors(star, ship.pos).normalize();
    const x = this.x.set(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0).cross(z);
    x.normalize();
    const y = this.y.crossVectors(z, x);
    for (let c = 0; c < CASCADES; c++) {
      const R = RADII[c];
      const tx = (2 * R) / SIZE;
      // the camera's place in light space (doubles), less its whole texels: the window's offset
      const cx = -(ship.pos.dot(x) - Math.floor(ship.pos.dot(x) / tx) * tx),
        cy = -(ship.pos.dot(y) - Math.floor(ship.pos.dot(y) / tx) * tx);
      const zMax = EXTEND * R,
        zMin = -R,
        span = zMax - zMin;
      this.m.set(x.x / R, x.y / R, x.z / R, -cx / R, y.x / R, y.y / R, y.z / R, -cy / R, -z.x / span, -z.y / span, -z.z / span, zMax / span, 0, 0, 0, 1);
      const layer = k * CASCADES + c;
      d.set(this.m.elements, layer * 16);
      this.device.queue.writeBuffer(this.casterBufs[layer], 0, new Float32Array(this.m.elements));
      d[V0 + c] = R;
      d[V0 + 4 + c] = tx;
      d[V0 + 8 + c] = (1.5 * tx) / span;
    }
  }

  /** Draw each cascade: `draw(pass, cascade)` puts the casters in (group 0 is the cascade's). */
  render(enc: GPUCommandEncoder, draw: (pass: GPURenderPassEncoder, c: number) => void, tw: (label: string) => GPURenderPassTimestampWrites | undefined) {
    if (!this.on) return;
    for (let layer = 0; layer < (this.on2 ? 2 : 1) * CASCADES; layer++) {
      const pass = enc.beginRenderPass({
        label: `shadow cascade ${layer}`,
        colorAttachments: [],
        depthStencilAttachment: { view: this.views[layer], depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
        timestampWrites: tw('shadows'),
      });
      pass.setBindGroup(0, this.casterGroups[layer]);
      draw(pass, layer % CASCADES);
      pass.end();
    }
  }

  dispose() {
    this.texture.destroy();
    this.uniform.destroy();
    for (const b of this.casterBufs) b.destroy();
  }
}
