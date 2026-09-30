/**
 * Ships and effects in WebGPU (docs/webgpu.md phase 6), ported from the WebGL renderer:
 *   - other ships (render/Traffic.ts): hulls within 200 km, marker dots, engine glows, the FTL flash,
 *     and FTL trails (render/Trail.ts records them) for them and for you;
 *   - dust round the ship in normal space (SceneRenderer.ts updateDust);
 *   - the mining laser's beam, hot spot and plume (render/Laser.ts);
 *   - the orbit preview ring (SceneRenderer.ts updateRing).
 * Point-like things (markers, glows, dust, plume) all go into the worlds' dots (one soft-dot shader).
 */
import type { Game } from '../Game';
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import { DUST, DUSTBOX, DUST_FADE_FROM, DUST_FADE_TO, RING_AP, RING_N, RING_PLAN } from '../render/look';
import { FtlTrail } from '../render/Trail';
import { orbitPreview } from '../sim/planner';
import { sunFraction } from '../sim/eclipse';
import { occluder } from '../sim/sight';
import { FLASH_S, type Npc } from '../sim/traffic';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { FX_WGSL } from './shaders';
import type { WorldsLayer } from './worlds';

const MAX_SHIPS = 16;
/** Turns the model (nose +z) to a ship's attitude (nose −z). */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
/** The laser's emitter, in the ship's axes (m): under the nose, a little ahead of the camera. */
const MUZZLE = new THREE.Vector3(0, -4, -6);
const PUFFS = 90,
  PUFF_LIFE = 2.5;
/** Line vertices: position + colour (rgba). */
const LINE_FLOATS = 7;
const MAX_LINE_VERTS = 8192;

interface Puff {
  off: THREE.Vector3; // from the rock's centre (m)
  vel: THREE.Vector3; // m/s, relative to the rock
  age: number;
  size: number;
}

/** The ship model's triangles (render/Traffic.ts shipModel), nose along +z. */
function shipModel() {
  const parts: [THREE.BufferGeometry, number, number, number][] = [
    [new THREE.CylinderGeometry(5, 6, 44, 14).rotateX(Math.PI / 2), 0, 0, 0], // hull
    [new THREE.ConeGeometry(5, 12, 14).rotateX(Math.PI / 2), 0, 0, 28], // nose
    [new THREE.BoxGeometry(4, 2.5, 8), 0, 5.2, 16], // cockpit
    [new THREE.BoxGeometry(0.8, 9, 10), 0, 8, -17], // fin
  ];
  for (const x of [-8, 8]) {
    parts.push([new THREE.CylinderGeometry(2.4, 2.8, 20, 10).rotateX(Math.PI / 2), x, -1, -14]); // engine pod
    parts.push([new THREE.BoxGeometry(4.5, 0.8, 6), x / 2, -1, -12]); // pylon
  }
  const pos: number[] = [],
    nrm: number[] = [];
  for (const [geo, x, y, z] of parts) {
    const g = geo.translate(x, y, z).toNonIndexed();
    pos.push(...(g.attributes.position.array as Float32Array));
    nrm.push(...(g.attributes.normal.array as Float32Array));
    g.dispose();
    geo.dispose();
  }
  return { pos: new Float32Array(pos) as Float32Array<ArrayBuffer>, nrm: new Float32Array(nrm) as Float32Array<ArrayBuffer> };
}

const blendAdd: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } };
const blendAlpha: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

export class EffectsLayer {
  private readonly fxBuf: GPUBuffer;
  private readonly fxData = new Float32Array(8);
  private readonly group: GPUBindGroup;
  private readonly hullPipe: GPURenderPipeline;
  private readonly trailPipe: GPURenderPipeline;
  private readonly orbitPipe: GPURenderPipeline;
  private readonly beamPipe: GPURenderPipeline;
  private readonly hull: { pos: GPUBuffer; nrm: GPUBuffer; count: number };
  private readonly inst: GPUBuffer;
  /** Per ship: its model matrix and the share of the star it sees. */
  private readonly instData = new Float32Array(MAX_SHIPS * 17);
  private hulls = 0;
  /** Every line this frame (trails, then the orbit ring), and each one's [first vertex, count]. */
  private readonly lineBuf: GPUBuffer;
  private readonly lineData = new Float32Array(MAX_LINE_VERTS * LINE_FLOATS);
  private lineN = 0;
  private trailRuns: [number, number][] = [];
  private orbitRun: [number, number] | null = null;
  private readonly beamBuf: GPUBuffer;
  private readonly beamIdx: GPUBuffer;
  private beamOn = false;

  private readonly own = new FtlTrail();
  private readonly trails = new Map<Npc, FtlTrail>();
  private sys = '';
  private readonly dustSeed: [number, number, number][] = [];
  private readonly puffs: Puff[] = [];
  private spawn = 0;
  private lastT = 0;
  private hitId = '';
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    this.fxBuf = device.createBuffer({ label: 'fx', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.fxBuf } }] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, layout] });
    const module = device.createShaderModule({ label: 'fx', code: FX_WGSL });
    const ms = { count: SAMPLES };
    const opaque: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' };
    const tested: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' };
    const v3 = (loc: number): GPUVertexBufferLayout => ({ arrayStride: 12, attributes: [{ shaderLocation: loc, offset: 0, format: 'float32x3' }] });
    this.hullPipe = device.createRenderPipeline({
      label: 'ship hulls',
      layout: pl,
      vertex: {
        module,
        entryPoint: 'vsHull',
        buffers: [
          v3(0),
          v3(1),
          {
            arrayStride: 68,
            stepMode: 'instance',
            attributes: [
              ...[0, 1, 2, 3].map((k) => ({ shaderLocation: 2 + k, offset: k * 16, format: 'float32x4' as const })),
              { shaderLocation: 6, offset: 64, format: 'float32' as const },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fsHull', targets: [{ format: HDR_FORMAT }] },
      primitive: { cullMode: 'back' },
      depthStencil: opaque,
      multisample: ms,
    });
    const lineLayout: GPUVertexBufferLayout = {
      arrayStride: LINE_FLOATS * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x4' },
      ],
    };
    const line = (label: string, fs: string, blend: GPUBlendState) =>
      device.createRenderPipeline({
        label,
        layout: pl,
        vertex: { module, entryPoint: 'vsLine', buffers: [lineLayout] },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR_FORMAT, blend }] },
        primitive: { topology: 'line-strip' },
        depthStencil: tested,
        multisample: ms,
      });
    this.trailPipe = line('ftl trails', 'fsLineAdd', blendAdd);
    this.orbitPipe = line('orbit preview', 'fsLineBlend', blendAlpha);
    this.beamPipe = device.createRenderPipeline({
      label: 'laser beam',
      layout: pl,
      vertex: {
        module,
        entryPoint: 'vsBeam',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fsBeam', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: ms,
    });
    const model = shipModel();
    const vb = (a: Float32Array<ArrayBuffer>) => {
      const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, a);
      return b;
    };
    this.hull = { pos: vb(model.pos), nrm: vb(model.nrm), count: model.pos.length / 3 };
    this.inst = device.createBuffer({ label: 'ship models', size: this.instData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.lineBuf = device.createBuffer({ label: 'lines', size: this.lineData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.beamBuf = device.createBuffer({ label: 'beam', size: 4 * 20, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.beamIdx = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.beamIdx, 0, new Uint16Array([0, 1, 2, 2, 1, 3]));
    const rnd = mulberry32(99);
    for (let i = 0; i < DUST; i++) this.dustSeed.push([rnd() * DUSTBOX, rnd() * DUSTBOX, rnd() * DUSTBOX]);
  }

  /** Per frame: everything's geometry and dots; `pr` is render px per CSS px. */
  update(g: Game, worlds: WorldsLayer, pr: number) {
    this.lineN = 0;
    this.trailRuns = [];
    this.orbitRun = null;
    const now = performance.now() / 1000;
    this.fxData[4] = now;
    this.updateTraffic(g, worlds, pr);
    this.updateDust(g, worlds, pr);
    this.updateLaser(g, worlds, pr, now);
    this.updateOrbit(g);
    this.device.queue.writeBuffer(this.fxBuf, 0, this.fxData);
    if (this.lineN) this.device.queue.writeBuffer(this.lineBuf, 0, this.lineData, 0, this.lineN * LINE_FLOATS);
  }

  /** A trail's line (render/Trail.ts fills it), copied, faded, into the line buffer. */
  private addTrail(tr: FtlTrail) {
    if (!tr.visible) return;
    const n = Math.min(tr.count, MAX_LINE_VERTS - this.lineN);
    if (n < 2) return;
    const p = tr.pos,
      f = tr.fade;
    const first = this.lineN;
    for (let i = 0; i < n; i++) {
      const a = f[i] * f[i] * 0.9;
      this.lineData.set([p[i * 3], p[i * 3 + 1], p[i * 3 + 2], 0.45 * a, 0.85 * a, 1.0 * a, 0], (this.lineN + i) * LINE_FLOATS);
    }
    this.lineN += n;
    this.trailRuns.push([first, n]);
  }

  private updateTraffic(g: Game, worlds: WorldsLayer, pr: number) {
    const { ship, simTime } = g;
    // a new system: the trails laid in the last one go
    if (g.cur.sys.id !== this.sys) {
      this.sys = g.cur.sys.id;
      this.own.clear();
      this.trails.clear();
    }
    // your own trail, from just behind the camera back along the way you came
    this.own.record(ship.pos, ship.travelDir, ship.mode === 'ftl' && !g.jump, simTime);
    this.own.draw(ship.pos, simTime, this.tmp.copy(ship.travelDir).multiplyScalar(-80));
    this.addTrail(this.own);
    for (const npc of g.traffic) {
      let tr = this.trails.get(npc);
      if (!tr) this.trails.set(npc, (tr = new FtlTrail()));
      tr.record(npc.pos, npc.vel, npc.ftl, simTime);
      tr.draw(ship.pos, simTime);
      if (!occluder(g.cur.bodies, ship.pos, npc.pos)) this.addTrail(tr);
    }
    for (const npc of [...this.trails.keys()]) if (!g.traffic.includes(npc)) this.trails.delete(npc); // gone from the system
    const light = this.tmp2.subVectors(g.cur.star.pos, ship.pos).normalize();
    this.fxData.set([light.x, light.y, light.z], 0);
    this.hulls = 0;
    for (const npc of g.traffic.slice(0, MAX_SHIPS)) {
      // behind a world: nothing of it shows
      if (occluder(g.cur.bodies, ship.pos, npc.pos)) continue;
      const rel = new THREE.Vector3().subVectors(npc.pos, ship.pos);
      if (rel.length() < 200e3) {
        this.m.compose(rel, this.q.copy(npc.q).multiply(FLIP), this.one);
        this.instData.set(this.m.elements, this.hulls * 17);
        this.instData[this.hulls++ * 17 + 16] = sunFraction(g.cur.bodies, g.cur.star, npc.pos);
      }
      // marker, and the engines: main at the tail while thrusting, retro at the nose while braking
      const ftl = npc.ftl;
      const mc = ftl ? [0.5, 0.9, 1.0] : [0.85, 0.85, 0.8];
      worlds.addDot(rel, mc[0], mc[1], mc[2], (ftl ? 5 : 3.5) * pr);
      if (npc.thrust !== 0) {
        const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(npc.q);
        const at = rel.clone().addScaledVector(nose, npc.thrust > 0 ? -36 : 34);
        const c = ftl ? [0.6, 0.95, 1.4] : npc.thrust > 0 ? [1.4, 0.8, 0.4] : [1.0, 0.7, 0.45];
        worlds.addDot(at, c[0], c[1], c[2], (ftl ? 9 : npc.thrust > 0 ? 6 : 4) * pr);
      }
      // the flash of entering or leaving FTL: a burst that swells and fades
      const fu = (simTime - npc.flashAt) / FLASH_S;
      if (fu >= 0 && fu < 1) {
        const k = (1 - fu) * (1 - fu) * 2.5;
        worlds.addDot(rel, 0.8 * k, 0.95 * k, 1.2 * k, (14 + 110 * Math.sqrt(fu)) * pr);
      }
    }
    if (this.hulls) this.device.queue.writeBuffer(this.inst, 0, this.instData, 0, this.hulls * 17);
  }

  /**
   * Dust round the ship in a wrapping box, fading toward its edges and out with speed (past a few
   * km per frame the grains would just re-scatter each frame and read as faint stars).
   */
  private updateDust(g: Game, worlds: WorldsLayer, pr: number) {
    const { ship } = g;
    const fade = 1 - THREE.MathUtils.smoothstep(g.curSpeed, DUST_FADE_FROM, DUST_FADE_TO);
    if (ship.mode !== 'normal' || fade <= 0) return;
    const mx = ((ship.pos.x % DUSTBOX) + DUSTBOX) % DUSTBOX,
      my = ((ship.pos.y % DUSTBOX) + DUSTBOX) % DUSTBOX,
      mz = ((ship.pos.z % DUSTBOX) + DUSTBOX) % DUSTBOX;
    const h = DUSTBOX / 2;
    const p = this.tmp;
    for (const s of this.dustSeed) {
      p.set(((((s[0] - mx) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h, ((((s[1] - my) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h, ((((s[2] - mz) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h);
      const f = Math.max(0, 1 - p.length() / h) * 0.55 * fade;
      if (f > 0) worlds.addDot(p, f, f * 0.92, f * 0.85, 2.2 * pr);
    }
  }

  private updateLaser(g: Game, worlds: WorldsLayer, pr: number, now: number) {
    const L = g.laser;
    const dt = Math.max(0, Math.min(0.1, g.simTime - this.lastT));
    this.lastT = g.simTime;
    this.beamOn = !!(L.on && L.end);
    if (!L.on || !L.end) {
      this.puffs.length = 0;
      return;
    }
    const { ship } = g;
    const w = g.frameBody;
    const pxPerRad = g.view.pxPerRad;
    // camera-relative ends
    const a = MUZZLE.clone().applyQuaternion(ship.q);
    const b = L.end.clone().add(w.pos).sub(ship.pos);
    const len = b.distanceTo(a);
    // a ribbon facing the camera (at the origin), at least ~2 px wide at each end
    const dir = b.clone().sub(a).normalize();
    const side = (p: THREE.Vector3) => new THREE.Vector3().crossVectors(dir, p).normalize().multiplyScalar(Math.max(0.35, (p.length() * 2.5) / pxPerRad));
    const sa = side(a),
      sb = side(b);
    const v = new Float32Array(20);
    v.set([a.x - sa.x, a.y - sa.y, a.z - sa.z, -1, 0], 0);
    v.set([a.x + sa.x, a.y + sa.y, a.z + sa.z, 1, 0], 5);
    v.set([b.x - sb.x, b.y - sb.y, b.z - sb.z, -1, len], 10);
    v.set([b.x + sb.x, b.y + sb.y, b.z + sb.z, 1, len], 15);
    this.device.queue.writeBuffer(this.beamBuf, 0, v);
    this.fxData[3] = L.hit ? 1.2 : 0.6;
    // the plume: specks thrown off along the rock's surface normal where it's hit
    if (L.hit) {
      if (L.hit.id !== this.hitId) this.puffs.length = 0;
      this.hitId = L.hit.id;
      // the hot spot, flickering
      const spot = Math.max(8, Math.min(60, (L.hit.size * 0.25 * pxPerRad) / b.length()));
      const f = 0.8 + 0.2 * Math.sin(now * 37) * Math.sin(now * 23);
      worlds.addDot(b, 1.6 * f, 1.3 * f, 1.0 * f, spot * pr);
      this.spawn += dt * 40;
      const nrm = L.hit.normal;
      while (this.spawn >= 1) {
        this.spawn -= 1;
        const vel = nrm.clone().multiplyScalar(15 + Math.random() * 35);
        vel.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(25));
        if (this.puffs.length >= PUFFS) this.puffs.shift();
        this.puffs.push({ off: L.end.clone().sub(L.hit.center), vel, age: 0, size: 2 + Math.random() * 3 });
      }
    } else this.puffs.length = 0;
    for (const p of this.puffs) {
      p.age += dt;
      p.off.addScaledVector(p.vel, dt);
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) if (this.puffs[i].age > PUFF_LIFE) this.puffs.splice(i, 1);
    // the rock's centre, camera-relative (the specks ride along with it)
    const c = L.hit ? L.hit.center.clone().add(w.pos).sub(ship.pos) : b;
    for (const p of this.puffs) {
      const at = this.tmp.copy(c).add(p.off);
      const k = 1 - p.age / PUFF_LIFE;
      const size = Math.max(2, Math.min(40, (p.size * (1 + p.age) * pxPerRad) / at.length())) * pr;
      worlds.addDot(at, 0.22 * k, 0.28 * k, 0.34 * k, size); // ice vapour
    }
  }

  /**
   * The orbit preview (L): the planned or autopilot orbit as a ring, depth-tested so the planet hides
   * its far side. Vertices spaced cubically from the ship (see SceneRenderer.ts updateRing).
   */
  private updateOrbit(g: Game) {
    const pv = orbitPreview(g);
    if (!pv || this.lineN + RING_N + 1 > MAX_LINE_VERTS) return;
    const { ship } = g;
    const centre = new THREE.Vector3().copy(pv.point ?? pv.body.pos).sub(ship.pos);
    let n: THREE.Vector3, r: number;
    if (pv.n) {
      n = pv.n;
      r = pv.r;
    } else {
      n = new THREE.Vector3().subVectors(pv.point!, pv.body.pos).normalize();
      r = Math.max(2e3, 0.012 * centre.length());
    }
    const a = new THREE.Vector3().subVectors(ship.pos, pv.point ?? pv.body.pos);
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0).cross(n);
    if (a.lengthSq() < 1e-6) a.set(0, 1, 0).cross(n);
    a.normalize();
    const b = new THREE.Vector3().crossVectors(n, a);
    // display-referred: the HDR target isn't sRGB-encoded
    const col = (pv.engaged ? RING_AP : RING_PLAN).clone().convertLinearToSRGB();
    const first = this.lineN;
    for (let i = 0; i <= RING_N; i++) {
      const k = i % RING_N; // (closed: back to the first vertex)
      const u = (2 * k) / RING_N - 1;
      const t = pv.n ? Math.PI * u * u * u : (k / RING_N) * Math.PI * 2,
        c = Math.cos(t) * r,
        s = Math.sin(t) * r;
      this.lineData.set([centre.x + a.x * c + b.x * s, centre.y + a.y * c + b.y * s, centre.z + a.z * c + b.z * s, col.r, col.g, col.b, 0.8], this.lineN++ * LINE_FLOATS);
    }
    this.orbitRun = [first, RING_N + 1];
  }

  drawOpaque(pass: GPURenderPassEncoder) {
    if (!this.hulls) return;
    pass.setPipeline(this.hullPipe);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(0, this.hull.pos);
    pass.setVertexBuffer(1, this.hull.nrm);
    pass.setVertexBuffer(2, this.inst);
    pass.draw(this.hull.count, this.hulls);
  }

  drawTransparent(pass: GPURenderPassEncoder) {
    pass.setBindGroup(1, this.group);
    if (this.trailRuns.length) {
      pass.setPipeline(this.trailPipe);
      pass.setVertexBuffer(0, this.lineBuf);
      for (const [first, n] of this.trailRuns) pass.draw(n, 1, first);
    }
    if (this.beamOn) {
      pass.setPipeline(this.beamPipe);
      pass.setVertexBuffer(0, this.beamBuf);
      pass.setIndexBuffer(this.beamIdx, 'uint16');
      pass.drawIndexed(6);
    }
    if (this.orbitRun) {
      pass.setPipeline(this.orbitPipe);
      pass.setVertexBuffer(0, this.lineBuf);
      pass.draw(this.orbitRun[1], 1, this.orbitRun[0]);
    }
  }

  dispose() {
    for (const b of [this.fxBuf, this.hull.pos, this.hull.nrm, this.inst, this.lineBuf, this.beamBuf, this.beamIdx]) b.destroy();
  }
}
