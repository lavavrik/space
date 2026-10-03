/**
 * Trojan swarms (docs/lagrange.md): the rocks near the ship in a swarm, drawn as instances of one
 * lumpy icosphere (shaders/swarmRock.wgsl). The CPU makes the list each frame from the same
 * generator the laser and the collisions read (sim/swarm.ts), so what's drawn is what's hit; there
 * are only ever a few hundred within SWARM_REACH, so it's one small instance buffer, no culling pass.
 */
import { sunsAt, type Suns } from '../sim/starlight';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { SWARM_INSTANCE_FLOATS, packSwarmRock, swarmSphere } from '../render/swarmMesh';
import { minedRocks } from '../sim/ringRocks';
import { SWARM_REACH, swarmCentre, swarmExponent, swarmRocks, type SwarmRock } from '../sim/swarm';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { SWARM_ROCK_WGSL } from './shaders';

/** Rocks drawn at most: the nearest of those listed. */
const MAX_ROCKS = 600;
/** Drawn while the ship is within this of the swarm's core (the Gaussian's exponent; ~3σ). */
const DRAW_EXPONENT = 5;

export class SwarmLayer {
  private readonly pipe: GPURenderPipeline;
  private readonly mesh: GPUBuffer;
  private readonly meshCount: number;
  private readonly inst: GPUBuffer;
  private readonly data = new Float32Array(MAX_ROCKS * SWARM_INSTANCE_FLOATS);
  private readonly uni: GPUBuffer;
  private readonly group: GPUBindGroup;
  private count = 0;
  private readonly suns: Suns = { s1: null as unknown as Suns['s1'], s2: null, c2: new THREE.Color() };
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const sphere = swarmSphere();
    this.meshCount = sphere.length / 3;
    this.mesh = device.createBuffer({ label: 'swarm rock mesh', size: sphere.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.mesh, 0, sphere);
    this.inst = device.createBuffer({ label: 'swarm rocks', size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uni = device.createBuffer({ label: 'swarm light', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uni } }] });
    const module = device.createShaderModule({ label: 'swarm rock', code: SWARM_ROCK_WGSL });
    const F = SWARM_INSTANCE_FLOATS * 4;
    this.pipe = device.createRenderPipeline({
      label: 'swarm rock',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, layout] }),
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          {
            arrayStride: F,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
              { shaderLocation: 4, offset: 48, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: SAMPLES },
    });
  }

  /** Per frame: the rocks near the ship, if it is in a swarm. */
  update(g: Game) {
    this.count = 0;
    const { ship, cur } = g;
    if (!cur.trojans?.length || ship.mode !== 'normal' && ship.mode !== 'ftl') return;
    // the swarm whose core is nearest the ship, if it's close enough to have rocks about it
    let best: { f: (typeof cur.trojans)[number]; c: ReturnType<typeof swarmCentre>; e: number } | null = null;
    for (const f of cur.trojans) {
      const c = swarmCentre(f);
      const e = swarmExponent(f, c, this.tmp.subVectors(ship.pos, c.pos));
      if (e < DRAW_EXPONENT && (!best || e < best.e)) best = { f, c, e };
    }
    if (!best) return;
    const list: SwarmRock[] = [];
    const zero = new THREE.Vector3();
    // (relative to the ship: camera-relative, which is what the shader wants)
    swarmRocks(best.f, best.c, ship.pos, ship.pos, SWARM_REACH, ship.pos, zero, list, undefined, (k) => minedRocks.get(k));
    list.sort((a, b) => a.pos.lengthSq() - b.pos.lengthSq());
    const n = Math.min(list.length, MAX_ROCKS);
    for (let i = 0; i < n; i++) {
      const r = list[i];
      const d = r.pos.length();
      // shrinking away over the last fifth of the reach, so none pops in at full size
      const fade = Math.min(1, Math.max(0, (SWARM_REACH - d) / (SWARM_REACH * 0.2)));
      packSwarmRock(this.data, i, r, r.pos, fade);
    }
    this.count = n;
    if (n) this.device.queue.writeBuffer(this.inst, 0, this.data.buffer, 0, n * SWARM_INSTANCE_FLOATS * 4);
    const suns = sunsAt(cur.stars, ship.pos, this.suns);
    const L = this.tmp.subVectors(suns.s1.pos, ship.pos).normalize();
    const col = suns.s1.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
    this.device.queue.writeBuffer(this.uni, 0, new Float32Array([L.x, L.y, L.z, 0, col.r, col.g, col.b, 0]));
  }

  drawOpaque(pass: GPURenderPassEncoder) {
    if (!this.count) return;
    pass.setPipeline(this.pipe);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(0, this.mesh);
    pass.setVertexBuffer(1, this.inst);
    pass.draw(this.meshCount, this.count);
  }

  dispose() {
    this.mesh.destroy();
    this.inst.destroy();
    this.uni.destroy();
  }
}
