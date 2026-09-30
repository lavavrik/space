/**
 * Stations (docs/webgpu.md phase 5; ported from the WebGL renderer's attachStation /
 * attachSkyStation and the stations part of renderScene): the orbital stations'
 * hulls, their interiors (up close), the approach corridor and its lights; sky stations hanging in
 * their world's air; and far off, a mint beacon dot (added to the worlds' dots).
 *
 * Each station has one uniform block (stationBody.wgsl Obj) that all its materials read.
 */
import { sunsAt, type Suns } from '../sim/starlight';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { STATION_RGB } from '../render/look';
import { skyStationGeometry } from '../render/skyMesh';
import { CORRIDOR_GROW, corridorGeometry, corridorLights, hullGeometry, interiorGeometry } from '../render/stationMesh';
import { slotUser } from '../sim/control';
import { sunFraction } from '../sim/eclipse';
import { occluder } from '../sim/sight';
import { SKY_PAD_COUNT, skyPadLocal } from '../sim/skyGeom';
import { CORRIDOR_M, PAD_R, padLocal, stationQuat } from '../sim/stationGeom';
import type { CurrentSystem, Station } from '../types';
import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { ShadowMap } from './shadowmap';
import { CORRIDOR_WGSL, SKY_STATION_WGSL, STATION_INTERIOR_WGSL, STATION_WGSL } from './shaders';
import type { WorldsLayer } from './worlds';

const OBJ_BYTES = 64 + 16 * 16;

interface Mesh {
  pos: GPUBuffer;
  nrm: GPUBuffer;
  count: number;
}

interface View {
  st: Station;
  buf: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  group: GPUBindGroup;
  /** Sky stations: their world's group (the air). */
  worldGroup: GPUBindGroup | null;
  corridor: Mesh | null;
  lights: { buf: GPUBuffer; count: number } | null;
  dist: number;
  pxR: number;
  show: boolean;
  showInner: boolean;
  showCorridor: boolean;
  showLights: boolean;
}

const blendAdd: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } };

export class StationsLayer {
  private readonly hull: Mesh;
  private readonly inside: Mesh;
  private readonly sky: Mesh;
  private readonly layout: GPUBindGroupLayout;
  private readonly hullPipe: GPURenderPipeline;
  private readonly innerPipe: GPURenderPipeline;
  private readonly skyPipe: GPURenderPipeline;
  private readonly corridorPipe: GPURenderPipeline;
  private readonly lampPipe: GPURenderPipeline;
  private readonly hullShadow: GPURenderPipeline;
  private readonly skyShadow: GPURenderPipeline;
  private views: View[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    worldLayout: GPUBindGroupLayout,
    casterLayout: GPUBindGroupLayout,
  ) {
    this.hull = this.mesh(hullGeometry());
    this.inside = this.mesh(interiorGeometry());
    this.sky = this.mesh(skyStationGeometry());
    this.layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.layout] });
    const skyPL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, worldLayout, this.layout] });
    const posNrm: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    ];
    const opaque: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' };
    const tested: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' };
    const ms = { count: SAMPLES };
    const solid = (label: string, code: string, layout: GPUPipelineLayout) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label,
        layout,
        vertex: { module, entryPoint: 'vs', buffers: posNrm },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { cullMode: 'none' }, // double-sided
        depthStencil: opaque,
        multisample: ms,
      });
    };
    this.hullPipe = solid('station', STATION_WGSL, pl);
    // into the shadow map: hulls and sky stations (their positions only)
    const caster = (label: string, code: string, layouts: GPUBindGroupLayout[]) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [casterLayout, ...layouts] }),
        vertex: { module: device.createShaderModule({ label, code }), entryPoint: 'vsShadow', buffers: [posNrm[0]] },
        primitive: { cullMode: 'none' },
        depthStencil: ShadowMap.depth,
      });
    this.hullShadow = caster('station shadow', STATION_WGSL, [this.layout]);
    this.skyShadow = caster('sky station shadow', SKY_STATION_WGSL, [worldLayout, this.layout]);
    this.innerPipe = solid('station interior', STATION_INTERIOR_WGSL, pl);
    this.skyPipe = solid('sky station', SKY_STATION_WGSL, skyPL);
    const corr = device.createShaderModule({ label: 'corridor', code: CORRIDOR_WGSL });
    this.corridorPipe = device.createRenderPipeline({
      label: 'corridor',
      layout: pl,
      vertex: { module: corr, entryPoint: 'vs', buffers: posNrm },
      fragment: { module: corr, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      primitive: { cullMode: 'none' },
      depthStencil: tested,
      multisample: ms,
    });
    this.lampPipe = device.createRenderPipeline({
      label: 'corridor lights',
      layout: pl,
      vertex: {
        module: corr,
        entryPoint: 'vsLamp',
        buffers: [
          {
            arrayStride: 20,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32' },
              { shaderLocation: 2, offset: 16, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module: corr, entryPoint: 'fsLamp', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: ms,
    });
  }

  /** A non-indexed three.js geometry's positions and normals as GPU buffers. */
  private mesh(geo: THREE.BufferGeometry): Mesh {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const buf = (a: Float32Array) => {
      const b = this.device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, a.buffer, a.byteOffset, a.byteLength);
      return b;
    };
    const pos = g.attributes.position.array as Float32Array;
    const m = { pos: buf(pos), nrm: buf(g.attributes.normal.array as Float32Array), count: pos.length / 3 };
    geo.dispose();
    if (g !== geo) g.dispose();
    return m;
  }

  setSystem(cur: CurrentSystem, worlds: WorldsLayer) {
    this.clear();
    const { device } = this;
    for (const st of cur.stations) {
      const buf = device.createBuffer({ label: st.name, size: OBJ_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new Float32Array(OBJ_BYTES / 4);
      const star = cur.star;
      const p = st.parent.pal;
      const sc = star.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
      const pc = p.a.clone().lerp(p.b, 0.5);
      data.set([sc.r, sc.g, sc.b, st.seed], 16 + 4);
      data.set([pc.r, pc.g, pc.b, 0], 16 + 12);
      let corridor: Mesh | null = null,
        lights: View['lights'] = null;
      if (st.sky) {
        data.set([0, PAD_R, -1, 0], 16 + 24);
        for (let i = 0; i < SKY_PAD_COUNT; i++) {
          const q = skyPadLocal(i).pos;
          data.set([q.x, q.y], 16 + 32 + i * 2);
        }
      } else {
        // the entry corridor, 5 km out along the spin axis
        const len = CORRIDOR_M / st.size;
        data.set([len, CORRIDOR_GROW, 0, 1], 16 + 20);
        corridor = this.mesh(corridorGeometry(len));
        const lg = corridorLights(len);
        const lp = lg.attributes.position.array as Float32Array,
          la = lg.attributes.aAlong.array as Float32Array,
          ls = lg.attributes.aSide.array as Float32Array;
        const n = la.length;
        const inst = new Float32Array(n * 5);
        for (let i = 0; i < n; i++) inst.set([lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2], la[i], ls[i]], i * 5);
        lg.dispose();
        const lb = device.createBuffer({ label: 'corridor lights', size: inst.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(lb, 0, inst);
        lights = { buf: lb, count: n };
      }
      this.views.push({
        st,
        buf,
        data,
        group: device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: buf } }] }),
        worldGroup: st.sky ? worlds.groupOf(st.parent) : null,
        corridor,
        lights,
        dist: Infinity,
        pxR: 0,
        show: false,
        showInner: false,
        showCorridor: false,
        showLights: false,
      });
    }
  }

  /** Per frame: place and light each station, pick its parts, and its beacon dot if far (renderScene). */
  private readonly suns: Suns = { s1: null as unknown as Suns['s1'], s2: null, c2: new THREE.Color() };

  update(g: Game, worlds: WorldsLayer) {
    const { ship, cur, simTime } = g;
    const pxPerRad = g.view.pxPerRad;
    const now = performance.now() / 1000;
    const dk = g.dock;
    for (const v of this.views) {
      const st = v.st;
      const rel = this.a.subVectors(st.pos, ship.pos);
      const d = rel.length();
      v.dist = d;
      v.pxR = (st.radius / d) * pxPerRad;
      v.show = v.pxR > 0.5;
      const f = v.data;
      this.m.compose(rel, stationQuat(st, simTime, this.q), this.s.setScalar(st.size));
      f.set(this.m.elements, 0);
      // its suns (sim/starlight.ts): the brighter here, and a pair's other
      const suns = sunsAt(cur.stars, st.pos, this.suns);
      const toStar = this.b.subVectors(suns.s1.pos, st.pos).normalize();
      f.set([toStar.x, toStar.y, toStar.z], 16);
      if (suns.s2) {
        const l2 = this.b.subVectors(suns.s2.pos, st.pos).normalize();
        f.set([l2.x, l2.y, l2.z, 1, suns.c2.r, suns.c2.g, suns.c2.b, 0], 16 + 56);
      } else f.fill(0, 16 + 56, 16 + 64);
      f[16 + 15] = now;
      if (st.sky) {
        // a sky station: its up, the sun, and your pad lit up while it's granted
        const up = this.b.subVectors(st.pos, st.parent.pos).normalize();
        f.set([up.x, up.y, up.z], 16 + 28);
        f[16 + 26] = dk && dk.station === st && !dk.docked ? dk.pad : -1;
      } else {
        // the interior only matters up close (it's seen through the slot, or from inside)
        v.showInner = d < st.size * 8;
        // traffic control (sim/control.ts): another ship using the slot, and which way it's going
        const other = d < 60e3 ? slotUser(g, st) : null;
        const outbound = !!other && (other.autodock?.phase === 'exit' || other.autodock?.phase === 'rise');
        v.showCorridor = ((!!dk && dk.station === st && !dk.docked) || !!other) && !g.inStation;
        v.showLights = d < 60e3 && !g.inStation;
        f[16 + 22] = other ? 1 : 0;
        f[16 + 23] = outbound ? -1 : 1;
        f[16 + 24] = pxPerRad;
        f[16 + 19] = dk && dk.station === st && !dk.docked ? 1 : 0;
        if (dk && dk.station === st) {
          const pl = padLocal(dk.pad).pos;
          f.set([pl.x, pl.y, pl.z], 16 + 16);
        }
        const par = st.parent;
        const w = this.b.subVectors(par.pos, st.pos);
        const pd = w.length();
        // lit: the share of the star in view (sim/eclipse.ts: the parent's shadow, moons, a penumbra)
        f[16 + 3] = sunFraction(cur.bodies, suns.s1, st.pos);
        f.set([w.x / pd, w.y / pd, w.z / pd, Math.cos(Math.asin(Math.min(1, par.radius / pd)))], 16 + 8);
      }
      this.device.queue.writeBuffer(v.buf, 0, f);
      // far off: a mint beacon dot (not through the world it's behind)
      if (v.pxR < 2.5 && !occluder(cur.bodies, ship.pos, st.pos)) {
        const a = v.pxR < 1.2 ? 1 : (2.5 - v.pxR) / 1.3;
        worlds.addDot(rel, STATION_RGB.r * a, STATION_RGB.g * a, STATION_RGB.b * a, 3.2 * worlds.pr);
      }
    }
  }

  drawOpaque(pass: GPURenderPassEncoder) {
    const draw = (m: Mesh) => {
      pass.setVertexBuffer(0, m.pos);
      pass.setVertexBuffer(1, m.nrm);
      pass.draw(m.count);
    };
    pass.setPipeline(this.hullPipe);
    for (const v of this.views)
      if (v.show && !v.st.sky) {
        pass.setBindGroup(1, v.group);
        draw(this.hull);
      }
    pass.setPipeline(this.innerPipe);
    for (const v of this.views)
      if (v.show && v.showInner) {
        pass.setBindGroup(1, v.group);
        draw(this.inside);
      }
    pass.setPipeline(this.skyPipe);
    for (const v of this.views)
      if (v.show && v.st.sky) {
        pass.setBindGroup(1, v.worldGroup!);
        pass.setBindGroup(2, v.group);
        draw(this.sky);
      }
  }

  /** Into shadow cascade c (half-width R): the stations within its reach. */
  drawShadow(pass: GPURenderPassEncoder, R: number) {
    for (const v of this.views) {
      if (!v.show || v.dist > R * 4 + v.st.size) continue;
      if (v.st.sky) {
        pass.setPipeline(this.skyShadow);
        pass.setBindGroup(1, v.worldGroup!);
        pass.setBindGroup(2, v.group);
        pass.setVertexBuffer(0, this.sky.pos);
        pass.draw(this.sky.count);
      } else {
        pass.setPipeline(this.hullShadow);
        pass.setBindGroup(1, v.group);
        pass.setVertexBuffer(0, this.hull.pos);
        pass.draw(this.hull.count);
      }
    }
  }

  /** Whether a station is within `d` (m): it and what's near it want shadows. */
  near(d: number) {
    return this.views.some((v) => v.dist < d + v.st.size);
  }

  /** The corridors and their lights (added light), far to near. */
  drawTransparent(pass: GPURenderPassEncoder) {
    const far = this.views.filter((v) => v.showCorridor || v.showLights).sort((a, b) => b.dist - a.dist);
    for (const v of far) {
      pass.setBindGroup(1, v.group);
      if (v.showCorridor && v.corridor) {
        pass.setPipeline(this.corridorPipe);
        pass.setVertexBuffer(0, v.corridor.pos);
        pass.setVertexBuffer(1, v.corridor.nrm);
        pass.draw(v.corridor.count);
      }
      if (v.showLights && v.lights) {
        pass.setPipeline(this.lampPipe);
        pass.setVertexBuffer(0, v.lights.buf);
        pass.draw(6, v.lights.count);
      }
    }
  }

  view(st: Station) {
    return this.views.find((v) => v.st === st);
  }

  private clear() {
    for (const v of this.views) {
      v.buf.destroy();
      v.corridor?.pos.destroy();
      v.corridor?.nrm.destroy();
      v.lights?.buf.destroy();
    }
    this.views = [];
  }

  dispose() {
    this.clear();
    for (const m of [this.hull, this.inside, this.sky]) {
      m.pos.destroy();
      m.nrm.destroy();
    }
  }
}
