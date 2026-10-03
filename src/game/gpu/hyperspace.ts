/**
 * The star field during a hyperspace transit, in light-years: every real system within SKY_RADIUS
 * of the path at its true place relative to the moving ship (nearby stars sweep past with parallax
 * and smear more than distant ones; streaks grow and shrink with the ship's speed), a head (drawn by the sky
 * stars' pipeline, as a direction) plus a streak trailing back along the direction of travel.
 *
 * Positions are in light-years, scaled up (SCALE) before drawing: only directions matter to the
 * projection, but the near plane would clip anything within half a unit of the camera.
 */
import { CORE_ID, coreSystem } from '../universe/core';
import { SKY_RADIUS } from '../constants';
import { THREE } from '../lib/three';
import { skyColor, skyLook, transitState, type TransitState } from '../sim/hyperspace';
import type { Jump, StarSystem } from '../types';
import { pairLight } from '../universe/binary';
import { systemsNear } from '../universe/galaxy';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { FX_WGSL } from './shaders';

/** How long (s) a streak "exposes": its length is the distance travelled in this time. */
const STREAK_S = 0.22;
const SCALE = 1e6;

export class HyperspaceLayer {
  private jump: Jump | null = null;
  private stars: StarSystem[] = [];
  private st: TransitState | undefined;
  private heads: GPUBuffer | null = null;
  private lines: GPUBuffer | null = null;
  private headData = new Float32Array(0);
  private lineData = new Float32Array(0);
  private readonly streakPipe: GPURenderPipeline;
  private readonly c = new THREE.Color();
  private readonly rel = new THREE.Vector3();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const module = device.createShaderModule({ label: 'hyperspace streaks', code: FX_WGSL });
    this.streakPipe = device.createRenderPipeline({
      label: 'hyperspace streaks',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: {
        module,
        entryPoint: 'vsLine',
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fsStreak',
        targets: [{ format: HDR_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
      },
      primitive: { topology: 'line-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: SAMPLES },
    });
  }

  private build(j: Jump) {
    this.free();
    this.jump = j;
    const mid = j.from.clone().add(j.dest.pos).multiplyScalar(0.5);
    const half = j.from.distanceTo(j.dest.pos) / 2;
    this.stars = systemsNear(mid, SKY_RADIUS + half);
    if (!this.stars.some((s) => s.id === CORE_ID)) this.stars.push(coreSystem()); // (in sight from anywhere)
    const N = Math.max(1, this.stars.length);
    this.headData = new Float32Array(N * 7);
    this.lineData = new Float32Array(N * 14);
    this.heads = this.device.createBuffer({ label: 'hyperspace heads', size: this.headData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.lines = this.device.createBuffer({ label: 'hyperspace streaks', size: this.lineData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  /** This frame's heads and streaks for jump `j` (in the tunnel). */
  update(j: Jump) {
    if (this.jump !== j) this.build(j);
    const st = (this.st = transitState(j, this.st));
    const tail = st.speed * STREAK_S;
    const blur = Math.min(1, st.speed / 2); // heads fade into their streaks at speed
    const hd = this.headData,
      ld = this.lineData;
    this.stars.forEach((s, i) => {
      const rel = this.rel.subVectors(s.pos, st.pos);
      const d = Math.max(rel.length(), 1e-4);
      // same look as the normal sky, so nothing pops at the start or the end
      const pl = pairLight(s); // (a pair: one point, both stars' light)
      const { size, k } = skyLook(pl.L, d, !!s.star.hole);
      const c = skyColor(pl.color, k, this.c);
      const hk = 1 - 0.45 * blur;
      hd.set([rel.x / d, rel.y / d, rel.z / d, c.r * hk, c.g * hk, c.b * hk, size], i * 7);
      // the tail is where the star appeared a moment ago, capped below its distance so a streak
      // never sweeps through the camera
      const L = Math.min(tail, 0.6 * d);
      ld.set([rel.x * SCALE, rel.y * SCALE, rel.z * SCALE, c.r * 1.3, c.g * 1.3, c.b * 1.3, 0], i * 14);
      ld.set([(rel.x + st.dir.x * L) * SCALE, (rel.y + st.dir.y * L) * SCALE, (rel.z + st.dir.z * L) * SCALE, 0, 0, 0, 0], i * 14 + 7);
    });
    this.device.queue.writeBuffer(this.heads!, 0, hd);
    this.device.queue.writeBuffer(this.lines!, 0, ld);
  }

  /** The heads, with the sky stars' pipeline already set. */
  drawHeads(pass: GPURenderPassEncoder) {
    if (!this.heads || !this.stars.length) return;
    pass.setVertexBuffer(0, this.heads);
    pass.draw(6, this.stars.length);
  }

  drawStreaks(pass: GPURenderPassEncoder) {
    if (!this.lines || !this.stars.length) return;
    pass.setPipeline(this.streakPipe);
    pass.setVertexBuffer(0, this.lines);
    pass.draw(this.stars.length * 2);
  }

  private free() {
    this.heads?.destroy();
    this.lines?.destroy();
    this.heads = this.lines = null;
    this.jump = null;
  }

  /** Out of the tunnel: let the star set go. */
  release() {
    if (this.jump) this.free();
  }

  dispose() {
    this.free();
  }
}
