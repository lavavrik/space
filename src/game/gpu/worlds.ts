/**
 * The system's bodies in WebGPU (docs/webgpu.md, phase 2): the star (disc and glow), planets and moons
 * (the far sphere: surface, terrain as bumps, city lights), their skies (a scattering shell), cloud
 * decks (a cube-map bake per world, a shell at the deck), ring discs, and dots for distant bodies.
 * Ported from the WebGL renderer's attachStar / attachWorld / renderScene. Up close, a world with
 * relief is LOD terrain chunks instead of its sphere (gpu/terrain.ts); and close to a ring, its rocks
 * (gpu/rings.ts).
 *
 * Draw order: opaque (surfaces, the star's disc), then the transparent layers far to near within
 * each (as three.js sorts them): glow, rings, dots; skies; cloud decks.
 */
import type { Game } from '../Game';
import { gpuSkip } from '../debug/costSweep';
import { AU, FOV, WT } from '../constants';
import { THREE } from '../lib/three';
import { noise3dBytes, noise3dGrads, NOISE3D_SIZE } from '../lib/noise3d';
import { airBeta, TERRAIN_NEAR, TERRAIN_PX } from '../render/look';
import { CITY_K } from '../render/exposure';
import { atmoOf } from '../sim/atmosphere';
import { CK, cloudKindOf, deckHeight } from '../sim/cloudKind';
import { populated } from '../sim/population';
import { hasCraters, reliefAmp, surfaceRadius, terrainOffsets, worldQuat } from '../sim/terrain';
import { occludersOf } from '../sim/eclipse';
import { sunsAt, type Suns } from '../sim/starlight';
import type { Body, CurrentSystem, Star, World } from '../types';
import { ATMO_WGSL, CLOUD_BAKE_WGSL, CLOUD_WGSL, DOTS_WGSL, PLANET_WGSL, RING_WGSL, STAR_WGSL, TERRAIN_BAKE_WGSL } from './shaders';
import { CHUNK_BYTES, TerrainGpu, TerrainShared } from './terrain';

import { DEPTH_FORMAT, HDR_FORMAT, SAMPLES } from './formats';
import { RingFieldGpu } from './rings';
import { terrainDebug } from '../debug/tdbg';

const WORLD_BYTES = 896;
const STAR_BYTES = 128;
/** The water's three wave octaves all repeat over this (m; planet.wgsl WAVE_L × the noise's period of 8). */
const WAVE_PERIOD = 3840;
const RING_BYTES = 160;
const CLOUD_CUBE = 1024;
const MAXDOTS = 2048; // bodies, stations, ships, dust, the laser's plume

interface Mesh {
  pos: GPUBuffer;
  nrm: GPUBuffer;
  idx: GPUBuffer;
  count: number;
  format: GPUIndexFormat;
}

interface WorldView {
  b: World;
  buf: GPUBuffer;
  data: ArrayBuffer;
  group: GPUBindGroup;
  cloud: GPUTexture | null;
  air: boolean;
  ring: { buf: GPUBuffer; group: GPUBindGroup; mesh: Mesh } | null;
  dotColor: THREE.Color;
  /** Up close, LOD terrain in place of the sphere (worlds with relief). */
  terrain: TerrainGpu | null;
  terrOn: boolean;
  dist: number;
  pxR: number;
  mesh: Mesh;
}

interface StarView {
  b: Star;
  buf: GPUBuffer;
  group: GPUBindGroup;
  dist: number;
  pxR: number;
}

const blendAdd: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } };
const blendSky: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
const blendAlpha: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

export class WorldsLayer {
  private readonly sphere: { hi: Mesh; mid: Mesh; lo: Mesh };
  private readonly noiseTex: GPUTexture;
  private readonly tmpV = new THREE.Vector3();
  private readonly noiseSamp: GPUSampler;
  /** The noise texture's lattice gradients (8³, rgba32float): its noise worked out exactly (noise3d.wgsl gnoise). */
  private readonly gradTex: GPUTexture;
  private readonly cloudSamp: GPUSampler;
  private readonly noCloud: GPUTexture;
  readonly worldLayout: GPUBindGroupLayout;
  /** The terrain's look at last frame's clouds (group 3 of the planet pipelines; vclouds.ts coverFor, planet.wgsl hiddenByClouds). */
  readonly coverLayout: GPUBindGroupLayout;
  /** This frame's: the clouded world's group, the group for every other world, and which world (its bind group) the first is for. */
  cover: { group: GPUBindGroup; none: GPUBindGroup; world: GPUBindGroup | null } | null = null;
  private readonly oneBufLayout: GPUBindGroupLayout;
  private readonly planetPipe: GPURenderPipeline;
  private readonly chunkPipe: GPURenderPipeline;
  private readonly terrain: TerrainShared;
  /** The far sphere's (unused) terrain-chunk group: the planet shader binds one either way. */
  private readonly noChunk: GPUBindGroup;
  private readonly noChunkBufs: GPUBuffer[];
  private readonly rocks: RingFieldGpu;
  private readonly suns: Suns = { s1: null as unknown as Suns['s1'], s2: null, c2: new THREE.Color() };
  private readonly atmoPipe: GPURenderPipeline;
  private readonly cloudPipe: GPURenderPipeline;
  private readonly cloudBakePipe: GPURenderPipeline;
  private readonly ringPipe: GPURenderPipeline;
  private readonly discPipe: GPURenderPipeline;
  private readonly glowPipe: GPURenderPipeline;
  private readonly dotsPipe: GPURenderPipeline;
  private readonly dotBuf: GPUBuffer;
  private readonly dotData = new Float32Array(MAXDOTS * 7);
  private dotCount = 0;
  private worlds: WorldView[] = [];
  /** One per star (a pair has two, docs/binaries.md). */
  private stars: StarView[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(
    private readonly device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    casterLayout: GPUBindGroupLayout,
  ) {
    this.sphere = { hi: this.mesh(new THREE.SphereGeometry(1, 320, 160)), mid: this.mesh(new THREE.SphereGeometry(1, 96, 48)), lo: this.mesh(new THREE.SphereGeometry(1, 32, 16)) };

    // the fine octaves' 3D noise (lib/noise3d.ts): 64³ r8, repeating, linear
    const n = NOISE3D_SIZE;
    this.noiseTex = device.createTexture({ label: 'noise3d', size: [n, n, n], dimension: '3d', format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.noiseTex }, noise3dBytes() as Uint8Array<ArrayBuffer>, { bytesPerRow: n, rowsPerImage: n }, [n, n, n]);
    this.gradTex = device.createTexture({ label: 'noise3d gradients', size: [8, 8, 8], dimension: '3d', format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.gradTex }, noise3dGrads() as Float32Array<ArrayBuffer>, { bytesPerRow: 8 * 16, rowsPerImage: 8 }, [8, 8, 8]);
    this.noiseSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.cloudSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.noCloud = device.createTexture({ label: 'no clouds', size: [1, 1, 6], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING });

    const FS = GPUShaderStage.FRAGMENT,
      VS = GPUShaderStage.VERTEX,
      CS = GPUShaderStage.COMPUTE;
    this.coverLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, texture: {} },
        { binding: 2, visibility: FS, sampler: {} },
      ],
    });
    this.worldLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VS | FS | CS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VS | FS | CS, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: VS | FS | CS, sampler: {} },
        { binding: 3, visibility: FS | CS, texture: { viewDimension: 'cube' } },
        { binding: 4, visibility: FS | CS, sampler: {} },
        { binding: 5, visibility: VS | FS | CS, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
      ],
    });
    // terrain chunks (chunk.wgsl): the uniforms and the bake, read when drawing, written by the bake
    const chunkLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: VS, buffer: { type: 'read-only-storage' } }, // (the world's chunk transforms, chunk.wgsl chunkModels)
      ],
    });
    const chunkBakeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: CS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: CS, buffer: { type: 'storage' } },
        { binding: 2, visibility: CS, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: CS, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.noChunkBufs = [
      device.createBuffer({ size: CHUNK_BYTES, usage: GPUBufferUsage.UNIFORM }),
      device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE }),
      device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE }),
    ];
    this.noChunk = device.createBindGroup({
      layout: chunkLayout,
      entries: [
        { binding: 0, resource: { buffer: this.noChunkBufs[0] } },
        { binding: 1, resource: { buffer: this.noChunkBufs[1] } },
        { binding: 4, resource: { buffer: this.noChunkBufs[2] } },
      ],
    });
    const bakeModule = device.createShaderModule({ label: 'terrain bake', code: TERRAIN_BAKE_WGSL });
    const bakePipe = device.createComputePipeline({
      label: 'terrain bake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.worldLayout, chunkBakeLayout] }),
      compute: { module: bakeModule, entryPoint: 'main' },
    });
    this.terrain = new TerrainShared(device, chunkLayout, chunkBakeLayout, bakePipe);
    this.rocks = new RingFieldGpu(device, frameLayout, this.noiseTex, this.noiseSamp, casterLayout);
    this.oneBufLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } }] });
    const worldPL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.worldLayout] });
    const planetPL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.worldLayout, chunkLayout, this.coverLayout] });
    const onePL = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.oneBufLayout] });

    const posNrm: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    ];
    const posOnly: GPUVertexBufferLayout[] = [posNrm[0]];
    const opaque: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' };
    const tested: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' };
    const ms = { count: SAMPLES };
    const mod = (label: string, code: string) => device.createShaderModule({ label, code });

    const planet = mod('planet', PLANET_WGSL);
    this.planetPipe = device.createRenderPipeline({
      label: 'planet',
      layout: planetPL,
      vertex: { module: planet, entryPoint: 'vs', buffers: posNrm },
      fragment: { module: planet, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { cullMode: 'back' },
      depthStencil: opaque,
      multisample: ms,
    });
    this.chunkPipe = device.createRenderPipeline({
      label: 'terrain',
      layout: planetPL,
      vertex: {
        module: planet,
        entryPoint: 'vsChunk',
        buffers: [
          posNrm[0],
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
        ],
      },
      fragment: { module: planet, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { cullMode: 'back' },
      depthStencil: opaque,
      multisample: ms,
    });
    const atmo = mod('atmosphere', ATMO_WGSL);
    this.atmoPipe = device.createRenderPipeline({
      label: 'atmosphere',
      layout: worldPL,
      vertex: { module: atmo, entryPoint: 'vs', buffers: posOnly },
      fragment: { module: atmo, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendSky }] },
      primitive: { cullMode: 'front' }, // drawn from inside: the far side of the shell
      depthStencil: tested,
      multisample: ms,
    });
    const cloud = mod('cloud layer', CLOUD_WGSL);
    this.cloudPipe = device.createRenderPipeline({
      label: 'cloud layer',
      layout: worldPL,
      vertex: { module: cloud, entryPoint: 'vs', buffers: posOnly },
      fragment: { module: cloud, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAlpha }] },
      primitive: { cullMode: 'none' },
      depthStencil: tested,
      multisample: ms,
    });
    const bake = mod('cloud bake', CLOUD_BAKE_WGSL);
    this.cloudBakePipe = device.createRenderPipeline({
      label: 'cloud bake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.oneBufLayout, this.worldLayout, chunkLayout] }),
      vertex: { module: bake, entryPoint: 'vs' },
      fragment: { module: bake, entryPoint: 'fs', targets: [{ format: 'rg16float' }] },
    });
    const ring = mod('ring', RING_WGSL);
    this.ringPipe = device.createRenderPipeline({
      label: 'ring',
      layout: onePL,
      vertex: { module: ring, entryPoint: 'vs', buffers: posOnly },
      fragment: { module: ring, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAlpha }] },
      primitive: { cullMode: 'none' },
      depthStencil: tested,
      multisample: ms,
    });
    const star = mod('star', STAR_WGSL);
    this.discPipe = device.createRenderPipeline({
      label: 'star disc',
      layout: onePL,
      vertex: { module: star, entryPoint: 'vsDisc', buffers: posNrm },
      fragment: { module: star, entryPoint: 'fsDisc', targets: [{ format: HDR_FORMAT }] },
      primitive: { cullMode: 'back' },
      depthStencil: opaque,
      multisample: ms,
    });
    this.glowPipe = device.createRenderPipeline({
      label: 'star glow',
      layout: onePL,
      vertex: { module: star, entryPoint: 'vsGlow' },
      fragment: { module: star, entryPoint: 'fsGlow', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: ms,
    });
    const dots = mod('dots', DOTS_WGSL);
    this.dotsPipe = device.createRenderPipeline({
      label: 'dots',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: {
        module: dots,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 28,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module: dots, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: blendAdd }] },
      depthStencil: tested,
      multisample: ms,
    });
    this.dotBuf = device.createBuffer({ label: 'dots', size: this.dotData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  /** A three.js geometry's vertices and indices as GPU buffers. */
  private mesh(geo: THREE.BufferGeometry): Mesh {
    const { device } = this;
    const buf = (data: ArrayBufferView, usage: number) => {
      const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    const pos = geo.attributes.position.array as Float32Array;
    const nrm = (geo.attributes.normal?.array as Float32Array | undefined) ?? new Float32Array(pos.length);
    const index = geo.index!.array;
    const big = pos.length / 3 > 65535;
    const idx = big ? new Uint32Array(index) : new Uint16Array(index);
    geo.dispose();
    return { pos: buf(pos, GPUBufferUsage.VERTEX), nrm: buf(nrm, GPUBufferUsage.VERTEX), idx: buf(idx, GPUBufferUsage.INDEX), count: index.length, format: big ? 'uint32' : 'uint16' };
  }

  private freeMesh(m: Mesh) {
    m.pos.destroy();
    m.nrm.destroy();
    m.idx.destroy();
  }

  /** A new system's bodies: uniform buffers, cloud bakes, ring discs. */
  setSystem(cur: CurrentSystem) {
    this.clear();
    const { device } = this;
    for (const b of cur.bodies) {
      if (b.kind === 'star') {
        const buf = device.createBuffer({ size: STAR_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.stars.push({ b, buf, group: device.createBindGroup({ layout: this.oneBufLayout, entries: [{ binding: 0, resource: { buffer: buf } }] }), dist: Infinity, pxR: 0 });
        continue;
      }
      const air = atmoOf(b);
      const clouded = !!cloudKindOf(b);
      const buf = device.createBuffer({ label: b.name, size: WORLD_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(WORLD_BYTES);
      this.fillStatic(b, data, deckHeight(b));
      device.queue.writeBuffer(buf, 0, data);
      const cloud = clouded ? device.createTexture({ label: `${b.name} clouds`, size: [CLOUD_CUBE, CLOUD_CUBE, 6], format: 'rg16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }) : null;
      const groupWith = (clouds: GPUTexture) =>
        device.createBindGroup({
          layout: this.worldLayout,
          entries: [
            { binding: 0, resource: { buffer: buf } },
            { binding: 1, resource: this.noiseTex.createView() },
            { binding: 2, resource: this.noiseSamp },
            { binding: 5, resource: this.gradTex.createView() },
            { binding: 3, resource: clouds.createView({ dimension: 'cube' }) },
            { binding: 4, resource: this.cloudSamp },
          ],
        });
      const group = groupWith(cloud ?? this.noCloud);
      // (the bake can't read the cube it writes: it binds the empty one)
      if (cloud) this.bakeClouds(cloud, groupWith(this.noCloud));
      let ring: WorldView['ring'] = null;
      if (b.ring) {
        const rbuf = device.createBuffer({ size: RING_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        ring = { buf: rbuf, group: device.createBindGroup({ layout: this.oneBufLayout, entries: [{ binding: 0, resource: { buffer: rbuf } }] }), mesh: this.mesh(new THREE.RingGeometry(b.ring.inner, b.ring.outer, 256, 1)) };
      }
      const dotColor = b.pal.a.clone().lerp(b.pal.b, 0.5).lerp(new THREE.Color(1, 1, 1), 0.4);
      const terrain = reliefAmp(b) > 0 ? new TerrainGpu(b, this.terrain, group) : null;
      this.worlds.push({ b, buf, data, group, cloud, air: !!air, ring, dotColor, terrain, terrOn: false, dist: Infinity, pxR: 0, mesh: this.sphere.mid });
    }
  }

  /** The uniforms that don't change frame to frame (world.wgsl World). */
  private fillStatic(b: World, data: ArrayBuffer, cloudH: number) {
    const f = new Float32Array(data),
      i = new Int32Array(data);
    const col = (c: THREE.Color, at: number, w = 0) => f.set([c.r, c.g, c.b, w], at);
    col(b.pal.a, 48);
    col(b.pal.b, 52);
    col(b.pal.c, 56);
    col(b.pal.d, 60);
    const atmo = b.pal.atmo;
    col(atmo ? atmo.c : new THREE.Color(0, 0, 0), 64, atmo ? atmo.k * 0.6 : 0);
    const air = atmoOf(b);
    const beta = airBeta(b);
    f.set([beta.x, beta.y, beta.z, air?.H ?? 1], 80);
    f[84] = b.radius + (air?.top ?? 0); // atTop
    f[85] = 45; // atSunI
    f[86] = air ? 1 : 0;
    // ozone, by the air's oxygen (Earth's 21 %: 1): atmo.wgsl's twilight colours
    f[102] = Math.min((air?.gases.find(([gas]) => gas === 'O₂')?.[1] ?? 0) / 0.21, 2);
    // a Titan's orange smog (atmo.wgsl atExt)
    f[103] = air && b.type === WT.Icy ? 1 : 0;
    f[87] = b.pal.sea;
    f[88] = b.seed;
    f[91] = cloudH;
    f[92] = b.radius;
    f[93] = hasCraters(b) ? 1 : 0;
    f[94] = reliefAmp(b);
    f[96] = populated(b) ? 1 : 0;
    f[97] = CITY_K;
    f[98] = b.radius + cloudH;
    i[99] = b.type;
    // what the clouds are made of (sim/cloudKind.ts): their colour, w: the kind
    const ck = cloudKindOf(b);
    f.set([ck?.color.r ?? 1, ck?.color.g ?? 1, ck?.color.b ?? 1, ck?.kind ?? 0], 220);
    i[100] = 5;
    const off = terrainOffsets(b.seed); // (qn and qc, per chunk, are in chunk.wgsl)
    for (let k = 0; k < 17; k++) f.set([off[k * 3], off[k * 3 + 1], off[k * 3 + 2], 0], 104 + k * 4);
  }

  /** A world's cloud pattern into its cube map, once (cloudBake.wgsl): a pass per face. */
  private bakeClouds(tex: GPUTexture, group: GPUBindGroup) {
    const { device } = this;
    for (let face = 0; face < 6; face++) {
      const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const u = new ArrayBuffer(16);
      new Uint32Array(u, 0, 1)[0] = face;
      new Float32Array(u, 4, 1)[0] = CLOUD_CUBE;
      device.queue.writeBuffer(buf, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: tex.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(this.cloudBakePipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.oneBufLayout, entries: [{ binding: 0, resource: { buffer: buf } }] }));
      pass.setBindGroup(1, group);
      pass.setBindGroup(2, this.noChunk); // (terrain.wgsl reads a chunk's uniforms; not here)
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
      buf.destroy();
    }
  }

  /** Per frame (before drawing): each body's place, size on screen and uniforms (renderScene's loop). */
  update(g: Game) {
    const { ship, cur, simTime } = g;
    const pxPerRad = g.view.pxPerRad;
    const { device, m, q, v, s } = this;
    for (const st of this.stars) {
      const b = st.b;
      const rel = v.subVectors(b.pos, ship.pos);
      const d = rel.length();
      st.dist = d;
      st.pxR = (b.radius / d) * pxPerRad;
      const flux = b.L * (AU / d) * (AU / d);
      const I = Math.min(1.5, Math.max(0.35, 0.95 + 0.2 * Math.log10(flux)));
      const minPx = (16 + 22 * I) * 1.6;
      const size = Math.max(b.radius * 5, (d / pxPerRad) * minPx);
      const f = new Float32Array(STAR_BYTES / 4);
      m.compose(rel, q.identity(), s.setScalar(b.radius));
      f.set(m.elements, 0);
      f.set([b.color.r, b.color.g, b.color.b, b.seed], 16);
      const gc = b.color.clone().lerp(new THREE.Color(1, 1, 1), 0.2);
      f.set([gc.r, gc.g, gc.b, I], 20);
      f.set([rel.x, rel.y, rel.z, size], 24);
      f[28] = simTime;
      // an eclipse (star.wgsl corona): how much of the disc nearer bodies cover, by their angular
      // sizes and separation (a body smaller than the disc covers at most its share of its area)
      const rs = Math.asin(Math.min(1, b.radius / d));
      let cov = 0;
      for (const o of cur.bodies) {
        if (o.kind === 'star') continue;
        const ro = this.tmpV.subVectors(o.pos, ship.pos);
        const dO = ro.length();
        if (dO >= d || dO <= o.radius) continue;
        const rb = Math.asin(Math.min(1, o.radius / dO));
        const sep = ro.angleTo(rel);
        const c = THREE.MathUtils.clamp((rb + rs - sep) / (2 * rs), 0, 1);
        cov = Math.max(cov, rb < rs ? c * (rb / rs) ** 2 : c);
      }
      f[29] = cov;
      f[30] = b.radius / size; // (the disc's radius in the glow's units)
      device.queue.writeBuffer(st.buf, 0, f);
    }
    this.dotCount = 0;
    this.vcOn = 0;
    this.vcGroup = null;
    this.vcLift = 0;
    let ringDone = false;
    this.rocks.off();
    for (const w of this.worlds) {
      const b = w.b;
      const rel = v.subVectors(b.pos, ship.pos);
      const d = rel.length();
      w.dist = d;
      const pxR = (b.radius / d) * pxPerRad;
      w.pxR = pxR;
      w.mesh = pxR > 140 ? this.sphere.hi : pxR > 14 ? this.sphere.mid : this.sphere.lo;
      const f = new Float32Array(w.data),
        i = new Int32Array(w.data);
      const wq = worldQuat(b, q);
      m.compose(rel, wq, s.setScalar(b.radius));
      f.set(m.elements, 0);
      m.makeRotationFromQuaternion(wq);
      f.set(m.elements, 16);
      const qInv = wq.clone().invert();
      m.makeRotationFromQuaternion(qInv);
      f.set(m.elements, 32);
      // its suns (sim/starlight.ts): the brighter here is `light`, a pair's other `light2`
      const suns = sunsAt(cur.stars, b.pos, this.suns);
      const s1 = suns.s1;
      const light = new THREE.Vector3().subVectors(s1.pos, b.pos).normalize();
      f.set([light.x, light.y, light.z, 0], 68);
      const lightL = light.clone().applyQuaternion(qInv);
      f.set([lightL.x, lightL.y, lightL.z, 0], 72);
      f.set([rel.x, rel.y, rel.z, b.radius], 76);
      // shadows (shadow.wgsl): the star and the bodies that can eclipse this one, from its centre
      f.set([s1.pos.x - b.pos.x, s1.pos.y - b.pos.y, s1.pos.z - b.pos.z, s1.radius], 172);
      if (suns.s2) {
        const s2 = suns.s2;
        const l2 = new THREE.Vector3().subVectors(s2.pos, b.pos).normalize();
        f.set([l2.x, l2.y, l2.z, 1], 196);
        l2.applyQuaternion(qInv);
        f.set([l2.x, l2.y, l2.z, 0], 200);
        f.set([s2.pos.x - b.pos.x, s2.pos.y - b.pos.y, s2.pos.z - b.pos.z, s2.radius], 204);
        f.set([suns.c2.r, suns.c2.g, suns.c2.b, 0], 208);
      } else f.fill(0, 196, 212);
      // the waves' origin (planet.wgsl waterWaves): the camera's place in the world's frame, less a
      // whole number of WAVE_PERIOD (in doubles here, so what the shader adds to its small
      // camera-relative positions is small too)
      const camL = v.subVectors(ship.pos, b.pos).applyQuaternion(qInv);
      // (and their clock: the time wrapped to an hour, precise in float32)
      f.set([camL.x - Math.round(camL.x / WAVE_PERIOD) * WAVE_PERIOD, camL.y - Math.round(camL.y / WAVE_PERIOD) * WAVE_PERIOD, camL.z - Math.round(camL.z / WAVE_PERIOD) * WAVE_PERIOD, simTime % 3600], 212);
      // moonlight and planetshine (planet.wgsl): the neighbour lighting this world's night
      shineOf(b, cur.bodies, s1.pos, f, 216);
      v.subVectors(b.pos, ship.pos); // (rel again: v is reused)
      const occ = occludersOf(b, cur.bodies, s1);
      occ.forEach((o, k) => f.set([o.pos.x - b.pos.x, o.pos.y - b.pos.y, o.pos.z - b.pos.z, o.radius], 176 + k * 4));
      f.set([b.ring?.inner ?? 0, b.ring?.outer ?? 0, b.ring?.seed ?? 0, occ.length], 192);
      // volumetric clouds (gpu/vclouds.ts): the nearest clouded world within 40 deck heights (~400 km
      // on an Earth); its flat deck fades out as they fade in (from 40 down to 25). From 8 down to 4
      // they switched to the flat deck abruptly while still close enough to see how much plainer it is
      const deckH = f[91];
      const vc = deckH > 0 && this.cloudsOn ? 1 - THREE.MathUtils.smoothstep(d - b.radius, 25 * deckH, 40 * deckH) : 0;
      f[101] = vc;
      if (vc > this.vcOn) {
        this.vcOn = vc;
        this.vcGroup = w.group;
        this.vcRel.copy(rel);
        this.vcQ.copy(wq);
        // the ground under you, if it's high: the cloud base (0.4 deck heights) kept ~1.2 km over it;
        // dust's base is the ground itself (clouds.wgsl cloudBaseK)
        const ground = surfaceRadius(b, ship.pos) - b.radius;
        const ck = cloudKindOf(b)?.kind;
        this.vcLift = ck === CK.Giant ? 0 : ck === CK.Dust ? Math.max(0, ground) : Math.max(0, ground + 1200 - 0.4 * deckH);
      }
      // up close, LOD terrain replaces the sphere: big on screen and actually close (render/look.ts)
      w.terrOn = !!w.terrain && pxR > TERRAIN_PX && d < b.radius * TERRAIN_NEAR;
      if (w.terrOn) {
        const cam = new THREE.Vector3().subVectors(ship.pos, b.pos).applyQuaternion(qInv);
        // the view (for the terrain's detail: only what's in it gets the periscope's): the nose in the
        // world's frame, the field's half-angle, and the unzoomed resolution
        const fwdL = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q).applyQuaternion(qInv);
        const halfFov = Math.atan(g.view.W / g.view.H * Math.tan((g.fov * Math.PI) / 360));
        const basePxPerRad = g.view.H / 2 / Math.tan((FOV * Math.PI) / 360);
        w.terrain!.update(cam, lightL, rel, wq, { pxPerRad, basePxPerRad, fwd: fwdL, halfFov });
      }
      f[89] = simTime;
      f[90] = d - b.radius;
      f[95] = terrainDebug.bits; // (was useQc, unused: the terrain shader's perf bisect, planet.wgsl dbg; per frame for the sweep)
      // (terrain chunks: all of them, their fragment shader drops what a pixel can't show by its own
      // derivatives; by the apparent radius, landed it was ~9, so the nearest ground was plain until the
      // periscope multiplied the radius)
      i[100] = w.terrOn ? 17 : Math.max(4, Math.min(17, Math.round(4 + Math.log2(Math.max(pxR, 1) / 30))));
      device.queue.writeBuffer(w.buf, 0, w.data);
      if (w.ring && b.ring) {
        // the disc: in the world's tilted plane (not spinning), radii in planet radii
        const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(b.seed), 0, Math.sin(b.seed)), b.tilt);
        const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        m.compose(rel, tilt.multiply(flat), s.setScalar(b.radius));
        const rf = new Float32Array(RING_BYTES / 4);
        rf.set(m.elements, 0);
        rf.set([b.ring.color.r, b.ring.color.g, b.ring.color.b, b.ring.seed], 16);
        rf.set([light.x, light.y, light.z, b.radius], 20);
        // up close, the ring's rocks (gpu/rings.ts); the first ringed world near enough has them,
        // and its disc fades out around the camera where they take over
        let fade = 0;
        const l2r = suns.s2 ? new THREE.Vector3().subVectors(suns.s2.pos, b.pos).normalize() : null;
        if (!ringDone && this.rocks.update(b, rel, b.axis, light, simTime, pxPerRad * this.pr, l2r, suns.c2)) {
          ringDone = true;
          fade = this.rocks.nearFade;
        }
        rf.set([rel.x, rel.y, rel.z, fade], 24);
        rf.set([b.ring.inner, b.ring.outer], 28);
        // (a pair's second sun, docs/binaries.md)
        const l2 = suns.s2 ? new THREE.Vector3().subVectors(suns.s2.pos, b.pos).normalize() : null;
        if (l2) rf.set([l2.x, l2.y, l2.z, 1, suns.c2.r, suns.c2.g, suns.c2.b, 0], 32);
        device.queue.writeBuffer(w.ring.buf, 0, rf);
      }
      // distant bodies as dots of reflected starlight
      if (pxR < 2.5) {
        const dS = b.pos.distanceTo(s1.pos);
        const toS = new THREE.Vector3().subVectors(s1.pos, b.pos).normalize();
        const phase = 0.5 * (1 - toS.dot(rel) / d);
        const dA = d / AU;
        const br = ((6e8 * b.albedo * s1.L * (b.radius / dS) ** 2) / (dA * dA)) * (0.15 + phase);
        const a = Math.max(0, Math.min(1, (Math.log10(br) + 3.2) / 3.2)) * (pxR < 1.2 ? 1 : (2.5 - pxR) / 1.3);
        if (a > 0.02) {
          const c = w.dotColor;
          const k = a * this.starExp; // like the stars
          this.addDot(rel, c.r * k, c.g * k, c.b * k, (2.2 + 2.5 * a) * this.pr);
        }
      }
    }
  }

  /** The terrain's state, for the perf overlay (the first world with its chunks up). */
  terrainStats() {
    return this.worlds.find((w) => w.terrOn)?.terrain!.stats() ?? '';
  }

  /** The world whose clouds are marched as volumes this frame (its bind group), and how far faded in. */
  vcGroup: GPUBindGroup | null = null;
  vcOn = 0;
  /** …and where that world is (camera-relative) and how it's turned: the clouds move with it. */
  readonly vcRel = new THREE.Vector3();
  readonly vcQ = new THREE.Quaternion();
  /** …and how far its clouds are lifted over the ground under you (m; vclouds.wgsl liftAt). */
  vcLift = 0;
  /** Settings: volumetric clouds at all (off: the flat deck all the way down). */
  cloudsOn = true;

  /** The stars' share of the exposure (render/exposure.ts STAR_EXP_P): planets' dots follow it. */
  starExp = 1;

  /** A dot at camera-relative `rel`: colour (display-referred) and size (render px). */
  addDot(rel: THREE.Vector3, r: number, g: number, b: number, size: number) {
    if (this.dotCount >= MAXDOTS) return;
    this.dotData.set([rel.x, rel.y, rel.z, r, g, b, size], this.dotCount * 7);
    this.dotCount++;
  }

  /** The frame's dots to the GPU (after everything has added its own). */
  flushDots() {
    if (this.dotCount) this.device.queue.writeBuffer(this.dotBuf, 0, this.dotData, 0, this.dotCount * 7);
  }

  /** A world's bind group (its uniforms and textures), for things drawn in its air. */
  groupOf(b: Body) {
    return this.worlds.find((w) => w.b === b)!.group;
  }

  /** Compute work before the frame's render pass: terrain chunks' bakes, the rocks' culling. `tw`: a pass's timestamp writes (gpu/timing.ts). */
  bake(enc: GPUCommandEncoder, frameGroup: GPUBindGroup, tw: (label: string) => GPUComputePassTimestampWrites | undefined) {
    for (const w of this.worlds) if (w.terrOn) w.terrain!.bake(enc, frameGroup, tw);
    this.rocks.cull(enc, frameGroup, tw);
  }

  /** Render pixels per CSS pixel (GpuRenderer.resize). */
  pr = 1;

  /** Into shadow cascade c (half-width R, texel tx): the ring's rocks. */
  drawShadow(pass: GPURenderPassEncoder, R: number, tx: number) {
    this.rocks.drawShadow(pass, R, tx);
  }

  /** Whether any rocks are out this frame (they cast shadows). */
  get rocksOut() {
    return this.rocks.isActive;
  }

  /** Opaque: surfaces and the star's disc. */
  drawOpaque(pass: GPURenderPassEncoder) {
    this.drawFar(pass);
    this.drawTerrain(pass);
    this.drawRocks(pass);
  }

  /** The ring's rocks, when close to it. */
  drawRocks(pass: GPURenderPassEncoder) {
    this.rocks.draw(pass);
  }

  /** The stars' discs and the worlds seen as spheres (too far for terrain). */
  drawFar(pass: GPURenderPassEncoder) {
    for (const st of this.stars) {
      if (st.pxR <= 0.6 || st.b.hole) continue; // (a black hole is gpu/blackhole.ts's)
      pass.setPipeline(this.discPipe);
      pass.setBindGroup(1, st.group);
      this.drawMesh(pass, this.sphere.mid, true);
    }
    pass.setPipeline(this.planetPipe);
    pass.setBindGroup(2, this.noChunk);
    if (this.cover) pass.setBindGroup(3, this.cover.none);
    for (const w of this.worlds) {
      if (w.pxR <= 0.6 || w.terrOn) continue;
      pass.setBindGroup(1, w.group);
      this.drawMesh(pass, w.mesh, true);
    }
  }

  /** The terrain chunks of the worlds near enough. */
  drawTerrain(pass: GPURenderPassEncoder) {
    const near = this.worlds.filter((w) => w.terrOn);
    if (near.length) {
      pass.setPipeline(this.chunkPipe);
      for (const w of near) {
        pass.setBindGroup(1, w.group);
        if (this.cover) pass.setBindGroup(3, w.group === this.cover.world ? this.cover.group : this.cover.none);
        w.terrain!.draw(pass);
      }
    }
  }

  /**
   * Transparent, far to near within each kind (glow, rings and dots; skies; cloud decks), as three.js
   * orders them (render order, then distance). `more` draws the rest of the first kind (stations'
   * corridors and lights, …) before the skies.
   */
  drawTransparent(pass: GPURenderPassEncoder, more: (pass: GPURenderPassEncoder) => void) {
    const far = [...this.worlds].sort((a, b) => b.dist - a.dist);
    // (each kind can be left out by the cost sweep: debug/costSweep.ts)
    const on = (part: string) => !gpuSkip.has(part);
    // (far to near, a pair's glows over each other)
    for (const st of on('star glows') ? [...this.stars].sort((a, b) => b.dist - a.dist) : []) {
      if (st.b.hole) continue;
      pass.setPipeline(this.glowPipe);
      pass.setBindGroup(1, st.group);
      pass.draw(6);
    }
    pass.setPipeline(this.ringPipe);
    for (const w of far) {
      if (!w.ring || !on('rings')) continue;
      pass.setBindGroup(1, w.ring.group);
      this.drawMesh(pass, w.ring.mesh, false);
    }
    if (this.dotCount && on('dots')) {
      pass.setPipeline(this.dotsPipe);
      pass.setVertexBuffer(0, this.dotBuf);
      pass.draw(6, this.dotCount);
    }
    more(pass);
    pass.setPipeline(this.atmoPipe);
    for (const w of far) {
      if (!w.air || w.pxR <= 2 || !on('atmospheres')) continue;
      pass.setBindGroup(1, w.group);
      this.drawMesh(pass, this.sphere.hi, false);
    }
    pass.setPipeline(this.cloudPipe);
    for (const w of far) {
      // (a giant's face is its cloud tops already, planet.wgsl: no deck over it, only the volumetric
      // layer up close)
      if (!w.cloud || w.pxR <= 2 || cloudKindOf(w.b)?.kind === CK.Giant || !on('cloud decks')) continue;
      pass.setBindGroup(1, w.group);
      this.drawMesh(pass, this.sphere.hi, false);
    }
  }

  private drawMesh(pass: GPURenderPassEncoder, mesh: Mesh, normals: boolean) {
    pass.setVertexBuffer(0, mesh.pos);
    if (normals) pass.setVertexBuffer(1, mesh.nrm);
    pass.setIndexBuffer(mesh.idx, mesh.format);
    pass.drawIndexed(mesh.count);
  }

  /** How far a body is and how big it looks (for the overlay). */
  view(b: Body) {
    const st = this.stars.find((x) => x.b === b);
    if (st) return st;
    return this.worlds.find((w) => w.b === b);
  }

  private clear() {
    for (const w of this.worlds) {
      w.terrain?.dispose();
      w.buf.destroy();
      w.cloud?.destroy();
      if (w.ring) {
        w.ring.buf.destroy();
        this.freeMesh(w.ring.mesh);
      }
    }
    this.worlds = [];
    for (const st of this.stars) st.buf.destroy();
    this.stars = [];
  }

  dispose() {
    this.clear();
    for (const mesh of Object.values(this.sphere)) this.freeMesh(mesh);
    this.noiseTex.destroy();
    this.gradTex.destroy();
    this.terrain.dispose();
    this.rocks.dispose();
    for (const b of this.noChunkBufs) b.destroy();
    this.noCloud.destroy();
    this.dotBuf.destroy();
  }
}

/**
 * Moonlight and planetshine (docs/terrain.md): the neighbour that lights a world's night side most,
 * its parent planet for a moon, its largest moon for a planet, as a light: the direction to it
 * (world axes, the same as world.light's) and how bright it is against the sun (its albedo, its
 * size from here squared, and how much of its sunlit side faces this way: a Lambert sphere's phase),
 * squashed as eyes adapting to the dark see it (³√: a full moon's 2.5e-6 of sunlight → ~0.04,
 * planetshine on a moon ~0.13; real, both were invisible). Into f at `at` (4 floats; 0 for none).
 */
function shineOf(b: Body, bodies: Body[], sun: THREE.Vector3, f: Float32Array, at: number) {
  f.fill(0, at, at + 4);
  if (b.kind === 'star') return;
  let src: Body | null = null;
  if (b.parent && b.parent.kind !== 'star') src = b.parent;
  else for (const o of bodies) if (o.kind !== 'star' && o.parent === b && (!src || o.radius > src.radius)) src = o;
  if (!src) return;
  const toSrc = new THREE.Vector3().subVectors(src.pos, b.pos);
  const d = toSrc.length();
  if (d <= src.radius + b.radius) return;
  const a = new THREE.Vector3().subVectors(sun, src.pos).angleTo(toSrc.clone().negate()); // (phase angle at the source)
  const phase = ((Math.PI - a) * Math.cos(a) + Math.sin(a)) / Math.PI;
  const I = (src.albedo ?? 0.3) * (src.radius / d) ** 2 * Math.max(phase, 0);
  if (I <= 0) return;
  toSrc.divideScalar(d);
  f.set([toSrc.x, toSrc.y, toSrc.z, Math.min(0.3, 3 * Math.cbrt(I))], at);
}

