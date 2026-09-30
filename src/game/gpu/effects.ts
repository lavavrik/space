/**
 * Ships and effects in WebGPU (docs/webgpu.md phase 6), ported from the WebGL renderer:
 *   - other ships (render/Traffic.ts): hulls within 200 km, marker dots, engine glows, the FTL flash,
 *     and FTL trails (render/Trail.ts records them) for them and for you;
 *   - grains and particles (gpu/particles.ts): dust, the ring's dust, wrecks' debris, re-entry
 *     plasma, other ships' exhaust;
 *   - the mining laser's beam, hot spot, sparks and plume (render/Laser.ts);
 *   - the orbit preview ring (SceneRenderer.ts updateRing).
 * Point-like marks (markers, glows, the hot spot) go into the worlds' dots (one soft-dot shader).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { DUST, DUSTBOX, DUST_FADE_FROM, DUST_FADE_TO, RING_AP, RING_N, RING_PLAN } from '../render/look';
import { FtlTrail } from '../render/Trail';
import { orbitPreview } from '../sim/planner';
import { atmoOf } from '../sim/atmosphere';
import { sunFraction } from '../sim/eclipse';
import { occluder } from '../sim/sight';
import { FLASH_S, type Npc } from '../sim/traffic';
import { RING_HALF_THICK, ringDensity } from '../sim/rings';
import { wrecksHere } from '../sim/wreck';
import type { Particles } from './particles';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { ShadowMap } from './shadowmap';
import { FX_WGSL } from './shaders';
import type { WorldsLayer } from './worlds';

const MAX_SHIPS = 256; // hulls drawn (sim/traffic.ts has at most 200 ships)
/** Turns the model (nose +z) to a ship's attitude (nose −z). */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
/** The laser's emitter, in the ship's axes (m): under the nose, a little ahead of the camera. */
const MUZZLE = new THREE.Vector3(0, -4, -6);
/** Line vertices: position + colour (rgba). */
const LINE_FLOATS = 7;
const MAX_LINE_VERTS = 65536; // (a couple of hundred ships' FTL trails)

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
  private readonly hullShadow: GPURenderPipeline;
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
  /** The belt's dust box's place in the ring's orbiting space (null: not in a belt). */
  private ringAnchor: THREE.Vector3 | null = null;
  private lastT = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    casterLayout: GPUBindGroupLayout,
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
    this.hullShadow = device.createRenderPipeline({
      label: 'ship hulls into the shadow map',
      layout: device.createPipelineLayout({ bindGroupLayouts: [casterLayout] }),
      vertex: {
        module,
        entryPoint: 'vsHullShadow',
        buffers: [
          v3(0),
          {
            arrayStride: 68,
            stepMode: 'instance',
            attributes: [0, 1, 2, 3].map((k) => ({ shaderLocation: 2 + k, offset: k * 16, format: 'float32x4' as const })),
          },
        ],
      },
      primitive: { cullMode: 'none' },
      depthStencil: ShadowMap.depth,
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
  }

  /** Per frame: everything's geometry and dots; `pr` is render px per CSS px. */
  update(g: Game, worlds: WorldsLayer, px: Particles, pr: number) {
    this.lineN = 0;
    this.trailRuns = [];
    this.orbitRun = null;
    const now = performance.now() / 1000;
    this.fxData[4] = now;
    const dt = Math.max(0, Math.min(0.1, g.simTime - this.lastT));
    this.lastT = g.simTime;
    this.updateTraffic(g, worlds, px, pr, dt);
    this.updateGrains(g, px, pr, dt);
    this.updateLaser(g, worlds, px, pr, now, dt);
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
    const L = this.lineData;
    for (let i = 0; i < n; i++) {
      const a = f[i] * f[i] * 0.9;
      const o = (this.lineN + i) * LINE_FLOATS;
      L[o] = p[i * 3];
      L[o + 1] = p[i * 3 + 1];
      L[o + 2] = p[i * 3 + 2];
      L[o + 3] = 0.45 * a;
      L[o + 4] = 0.85 * a;
      L[o + 5] = a;
      L[o + 6] = 0;
    }
    this.lineN += n;
    this.trailRuns.push([first, n]);
  }

  private updateTraffic(g: Game, worlds: WorldsLayer, px: Particles, pr: number, dt: number) {
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
    for (const npc of g.traffic) {
      // on a pad inside an orbital station: seen only from in there (its hull on the pad, no marker).
      // On a sky station's open deck it's in plain view (hidden, it vanished as it touched down)
      const docked = npc.task === 'docked';
      const inside = docked && npc.at?.kind === 'station' && !npc.at.sky;
      if (inside && npc.at !== g.inStation && !(g.dock?.docked && g.dock.station === npc.at)) continue;
      // behind a world: nothing of it shows
      if (occluder(g.cur.bodies, ship.pos, npc.pos)) continue;
      const rel = new THREE.Vector3().subVectors(npc.pos, ship.pos);
      if (rel.length() < 200e3 && this.hulls < MAX_SHIPS) {
        this.m.compose(rel, this.q.copy(npc.q).multiply(FLIP), this.one);
        this.instData.set(this.m.elements, this.hulls * 17);
        this.instData[this.hulls++ * 17 + 16] = sunFraction(g.cur.bodies, g.cur.star, npc.pos);
      }
      if (docked) continue;
      // marker, and the engines: main at the tail while thrusting, retro at the nose while braking
      const ftl = npc.ftl;
      const mc = ftl ? [0.5, 0.9, 1.0] : [0.85, 0.85, 0.8];
      worlds.addDot(rel, mc[0], mc[1], mc[2], (ftl ? 5 : 3.5) * pr);
      if (npc.thrust !== 0) {
        // where it fires from: the main engine at the tail (pushing along the nose), the retros at
        // the nose (against it), or the lift jets under the hull (across it: hovering down onto a
        // deck, which fired from the nose when only along/against was known)
        const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(npc.q);
        const td = npc.thrustDir ? new THREE.Vector3(npc.thrustDir.x, npc.thrustDir.y, npc.thrustDir.z) : nose.clone().multiplyScalar(npc.thrust);
        const along = td.dot(nose);
        const kind = ftl || along > 0.6 ? 'main' : along < -0.6 ? 'retro' : 'lift';
        const at = kind === 'main' ? rel.clone().addScaledVector(nose, -36) : kind === 'retro' ? rel.clone().addScaledVector(nose, 34) : rel.clone().addScaledVector(td, -8);
        const c = ftl ? [0.6, 0.95, 1.4] : kind === 'main' ? [1.4, 0.8, 0.4] : [1.0, 0.7, 0.45];
        worlds.addDot(at, c[0], c[1], c[2], (ftl ? 9 : kind === 'main' ? 6 : 4) * pr);
        // its exhaust: a plume of glowing gas, the other way from the push (particles; in normal
        // space, within 60 km)
        if (!ftl && rel.length() < 60e3) {
          const base = new THREE.Vector3().subVectors(npc.vel, g.frameBody.vel ?? new THREE.Vector3());
          const k = kind === 'main' ? 1 : 0.5;
          px.emit({ key: `x${g.traffic.indexOf(npc)}`, pos: at, vel: base, dir: td.clone().negate(), speed: kind === 'lift' ? 150 : 250, spread: kind === 'lift' ? 40 : 30, count: 300 * k * dt, life: 1.0, color: [0.6 * k, 0.35 * k, 0.18 * k], size: 2.5, growth: 2.5, drag: 0.5, streak: 0.02 });
        }
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
   * Grains and particles (gpu/particles.ts):
   *   - dust round the ship in normal space, in a repeating box fixed in space, fading with speed
   *     (past a few km per frame it would read as faint stars);
   *   - in a ring's belt, its fine ice dust, in a box that orbits with the ring (so it hangs still
   *     round rocks you're matched with), as dense as the ring is there;
   *   - round a wreck, its debris, glinting;
   *   - re-entry: plasma streaming past once the air heats the hull (from ~0.1 MW/m²).
   */
  private updateGrains(g: Game, px: Particles, pr: number, dt: number) {
    const { ship } = g;
    // (space dust: gone in air, fading out through the upper half of it; on the ground it shimmered)
    const air = atmoOf(g.frameBody);
    const inAir = air ? 1 - THREE.MathUtils.smoothstep(ship.pos.distanceTo(g.frameBody.pos) - g.frameBody.radius, air.top * 0.5, air.top) : 0;
    const fade = (1 - THREE.MathUtils.smoothstep(g.curSpeed, DUST_FADE_FROM, DUST_FADE_TO)) * (1 - inAir);
    if (ship.mode === 'normal' && fade > 0) {
      const f = 0.55 * fade;
      px.field({ mode: 'wrap', at: ship.pos, size: DUSTBOX, count: DUST, seed: 99, grain: -2.2 * pr, color: [f, f * 0.92, f * 0.85] });
    }
    // the belt's dust, orbiting with the ring
    const b = g.frameBody;
    const sun = sunFraction(g.cur.bodies, g.cur.star, ship.pos);
    if (b.kind !== 'star' && b.ring && ship.mode === 'normal') {
      const rel = this.tmp.subVectors(ship.pos, b.pos);
      const n = this.tmp2.set(b.axis.x, b.axis.y, b.axis.z).normalize();
      const h = rel.dot(n);
      const radial = rel.clone().addScaledVector(n, -h);
      const r = radial.length();
      const dens = (ringDensity(b, r / b.radius) / 0.85) * (1 - THREE.MathUtils.smoothstep(Math.abs(h), RING_HALF_THICK, RING_HALF_THICK * 2));
      if (dens > 0.01) {
        const vOrb = new THREE.Vector3().crossVectors(n, radial).normalize().multiplyScalar(Math.sqrt(b.mu / r));
        if (!this.ringAnchor) this.ringAnchor = new THREE.Vector3(Math.random() * 1e4, 0, 0);
        this.ringAnchor.addScaledVector(ship.vel.clone().sub(vOrb), dt);
        const c = b.ring.color;
        const k = 5 * sun * Math.min(1, dens);
        // fine ice dust (a few px, glinting, drifting), and nearer gravel: centimetre pebbles, shaded
        // like the rocks, bigger the nearer, so the space round you has depth and parallax
        px.field({ mode: 'wrap', at: this.ringAnchor, size: 400, count: Math.round(60000 * Math.min(1, dens)), seed: 7, grain: -1.5 * pr, color: [c.r * k, c.g * k, c.b * k], glint: 5, drift: 0.6 });
        const kg = 1.2 * sun * Math.min(1, dens);
        px.field({ mode: 'wrap', at: this.ringAnchor, size: 120, count: Math.round(2500 * Math.min(1, dens)), seed: 11, grain: 0.06, color: [c.r * kg, c.g * kg, c.b * kg], glint: 2, drift: 0.25 });
      } else this.ringAnchor = null;
    } else this.ringAnchor = null;
    // wrecks' debris
    for (const w of wrecksHere(g)) {
      const at = new THREE.Vector3().subVectors(w.pos, ship.pos);
      if (at.length() > 40e3) continue;
      const k = 0.35 * sunFraction(g.cur.bodies, g.cur.star, w.pos);
      px.field({ mode: 'ball', at, size: 90, count: 2500, seed: w.lostAt | 0, grain: 0.35, color: [0.55 * k + 0.004, 0.55 * k + 0.004, 0.58 * k + 0.004], glint: 8 });
    }
    // re-entry plasma: the air ahead heated past glowing, streaming past the ship
    const a = g.aero;
    if (a.body && a.speed > 1500 && a.rho > 0 && !g.inStation) {
      const q = 0.5 * a.rho * a.speed ** 3;
      const k = THREE.MathUtils.clamp((Math.log10(q) - 5) / 2, 0, 1);
      if (k > 0) {
        const dir = ship.vel.clone().normalize();
        px.emit({ key: 'plasma', pos: dir.multiplyScalar(140), vel: new THREE.Vector3(), region: 70, count: 8000 * k * dt, life: 0.12, lifeJitter: 0.5, color: [5 * k, 2.2 * k, 0.8 * k], size: 0.8, streak: 0.012 });
      }
    }
  }

  private updateLaser(g: Game, worlds: WorldsLayer, px: Particles, pr: number, now: number, dt: number) {
    const L = g.laser;
    this.beamOn = !!(L.on && L.end);
    if (!L.on || !L.end) return;
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
    // where it hits: a white-hot spot, sparks, and the plume, ice boiling off along the surface's normal
    if (L.hit) {
      const spot = Math.max(8, Math.min(60, (L.hit.size * 0.25 * pxPerRad) / b.length()));
      const f = 0.8 + 0.2 * Math.sin(now * 37) * Math.sin(now * 23);
      worlds.addDot(b, 1.6 * f, 1.3 * f, 1.0 * f, spot * pr);
      const nrm = L.hit.normal;
      // (thin: a thousand overlapping puffs added up to a white blob that hid the rock)
      px.emit({ key: 'plume', pos: b, vel: ship.vel, dir: nrm, speed: 18, spread: 40, count: 200 * dt, life: 2.0, color: [0.05, 0.065, 0.08], size: 1.5, growth: 0.6, drag: 0.2, fadeIn: 0.1 });
      px.emit({ key: 'sparks', pos: b, vel: ship.vel, dir: nrm, speed: 25, spread: 80, count: 250 * dt, life: 0.4, color: [3, 1.5, 0.5], size: 0.15, streak: 0.04, drag: 2 });
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

  /** Into a shadow cascade: other ships' hulls. */
  drawShadow(pass: GPURenderPassEncoder) {
    if (!this.hulls) return;
    pass.setPipeline(this.hullShadow);
    pass.setVertexBuffer(0, this.hull.pos);
    pass.setVertexBuffer(1, this.inst);
    pass.draw(this.hull.count, this.hulls);
  }

  /** How many ships' hulls are drawn this frame (they cast shadows). */
  get hullCount() {
    return this.hulls;
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
