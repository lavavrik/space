/*
 * Planet terrain up close: a cube-sphere quadtree of chunks, each a 32×32 grid raised by the
 * terrain height in the vertex shader (planet.vert.glsl with TERRAIN, height in terrain.glsl).
 * See docs/terrain.md.
 *
 * - Each cube face is a quadtree. A chunk splits into four when the camera is within SPLIT_K of its
 *   edge length, down to MIN_SPACING between vertices (~8 m), so detail follows you to the ground.
 * - Vertex positions are built on the CPU in double precision, relative to the chunk's centre, and
 *   the chunk mesh sits at that centre, so nothing loses precision on a 6,000 km world.
 * - A chunk's vertices carry only the octaves its spacing can show (uVOct); the fragment shader
 *   bump-maps the finer ones, so shading doesn't change when a chunk splits, only the silhouette.
 * - The terrain isn't evaluated per frame: a chunk's heights, normals, sun shadows and coarse
 *   terrain state are baked once into a small float texture (planet.vert.glsl, TERRAIN_BAKE), and
 *   re-baked only when the sun has moved over it by SUN_REBAKE (the world turns). Drawing just reads
 *   it, and each pixel works out only the few octaves finer than its chunk's vertices.
 * - Skirts hang from every edge to hide the cracks where levels meet: only as deep as a crack can
 *   be, and shaded cheaply below their top half (planet.frag.glsl), since hidden or not they're
 *   shaded (docs/perf.md, "Terrain skirts").
 * - Chunks entirely beyond the horizon aren't drawn; unused ones are freed after a while.
 */
import { THREE } from '../lib/three';
import { reliefAmp, T_OCT_MAX, terrainOffsets } from '../sim/terrain';
import type { World } from '../types';
import { PLANET_FS, PLANET_VS, TERRAIN_BAKE_FS } from './shaders';

type Uniforms = Record<string, THREE.IUniform>;

const N = 32; // quads per chunk edge
const SPLIT_K = 1.6; // split when the camera is within this many edge lengths (quads ~15–20 px on screen)
const MIN_SPACING = 8; // m between vertices at the finest level
const MAX_BUILDS = 12; // chunk meshes built per frame at most (the rest wait a frame)
const KEEP_FRAMES = 240; // free a chunk unused this long
const SUN_REBAKE = Math.cos(0.004); // re-bake a chunk's shadows once the sun has moved ~0.2° over it
const MAX_REBAKES = 8; // shadow re-bakes per frame
const SKIRT_SPACINGS = 1; // skirt depth beyond the missing octaves' amplitude, in vertex spacings

/** Cube faces: normal n and in-face axes u, v with u × v = n (so triangles face outward). */
const FACES: [number, number, number][][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

/** Unit direction for face f at face coordinates s, t ∈ [−1, 1] (tan-warped, so cells are ~even). */
function faceDir(f: number, s: number, t: number, out: number[]) {
  const [n, u, v] = FACES[f];
  const a = Math.tan((s * Math.PI) / 4),
    b = Math.tan((t * Math.PI) / 4);
  const x = n[0] + a * u[0] + b * v[0],
    y = n[1] + a * u[1] + b * v[1],
    z = n[2] + a * u[2] + b * v[2];
  const l = Math.hypot(x, y, z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

interface Chunk {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  used: number;
  bake: THREE.WebGLRenderTarget;
  sun: THREE.Vector3; // the sun direction it was baked with (world's frame)
}

export class TerrainView {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, Chunk>();
  private readonly R: number;
  private readonly A: number;
  private frame = 0;
  private builds = 0;
  private readonly tmp: number[] = [0, 0, 0];
  private rebakes = 0;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCam = new THREE.OrthographicCamera();
  private readonly bakeMat: THREE.ShaderMaterial;
  private gl!: THREE.WebGLRenderer;
  private readonly sun = new THREE.Vector3(0, 1, 0);
  private readonly off: Float32Array;

  constructor(
    b: World,
    private readonly uni: Uniforms,
  ) {
    this.R = b.radius;
    this.A = reliefAmp(b);
    this.off = terrainOffsets(b.seed);
    this.root.visible = false;
    this.bakeMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VS,
      fragmentShader: TERRAIN_BAKE_FS,
      defines: { TERRAIN_BAKE: '' },
      uniforms: {
        ...uni,
        uVOct: { value: 0 },
        uSpacing: { value: 1 },
        uSkirtD: { value: 0 },
        uGridW: { value: N + 1 },
        uLightL: { value: new THREE.Vector3() },
        uParity: { value: 0 },
        uQc: { value: new Float32Array(T_OCT_MAX * 3) },
        uQn: { value: new Float32Array(T_OCT_MAX * 3) },
        uUseQc: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Pick and show the chunks for a camera at `cam` (m, in the world's own frame), with the sun in
   * direction `sun` (same frame). Bakes new chunks and re-bakes ones the sun has moved over.
   */
  update(cam: THREE.Vector3, sun: THREE.Vector3, gl: THREE.WebGLRenderer) {
    this.frame++;
    this.builds = 0;
    this.rebakes = 0;
    this.gl = gl;
    this.sun.copy(sun);
    for (const c of this.chunks.values()) c.mesh.visible = false;
    const camDist = cam.length();
    const camDir = cam.clone().divideScalar(camDist);
    // the horizon, allowing for mountains: beyond it nothing is visible
    const horizon = Math.acos(Math.min(1, (this.R - this.A) / Math.max(camDist, this.R)));
    for (let f = 0; f < 6; f++) this.visit(f, 0, 0, 0, cam, camDir, horizon);
    for (const [k, c] of this.chunks)
      if (this.frame - c.used > KEEP_FRAMES) {
        this.root.remove(c.mesh);
        this.free(c);
        this.chunks.delete(k);
      }
  }

  private visit(f: number, L: number, i: number, j: number, cam: THREE.Vector3, camDir: THREE.Vector3, horizon: number) {
    const n = 2 ** L;
    const edge = (this.R * (Math.PI / 2)) / n;
    const c = faceDir(f, -1 + (2 * (i + 0.5)) / n, -1 + (2 * (j + 0.5)) / n, this.tmp);
    // beyond the horizon (with the chunk's own angular size): skip it and everything under it
    const ang = Math.acos(Math.max(-1, Math.min(1, c[0] * camDir.x + c[1] * camDir.y + c[2] * camDir.z)));
    if (ang - (edge / this.R) * 0.8 > horizon) return;
    const dist = Math.hypot(cam.x - c[0] * this.R, cam.y - c[1] * this.R, cam.z - c[2] * this.R);
    const canSplit = edge / N / 2 >= MIN_SPACING;
    if (canSplit && dist < SPLIT_K * edge) {
      // split, if all four children are ready (or can be built this frame); else draw this one
      const kids: [number, number][] = [
        [2 * i, 2 * j],
        [2 * i + 1, 2 * j],
        [2 * i, 2 * j + 1],
        [2 * i + 1, 2 * j + 1],
      ];
      const missing = kids.filter(([a, b2]) => !this.chunks.has(key(f, L + 1, a, b2))).length;
      if (this.builds + missing <= MAX_BUILDS) {
        for (const [a, b2] of kids) this.visit(f, L + 1, a, b2, cam, camDir, horizon);
        return;
      }
    }
    this.show(f, L, i, j);
  }

  private show(f: number, L: number, i: number, j: number) {
    const k = key(f, L, i, j);
    let c = this.chunks.get(k);
    if (!c) {
      this.builds++;
      const bake = new THREE.WebGLRenderTarget(2 * (N + 1), N + 1, {
        type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false,
      });
      c = { mesh: this.build(f, L, i, j, bake.texture), used: 0, bake, sun: new THREE.Vector3() };
      this.chunks.set(k, c);
      this.root.add(c.mesh);
      this.bake(c);
    } else if (c.sun.dot(this.sun) < SUN_REBAKE && this.rebakes < MAX_REBAKES) {
      this.rebakes++;
      this.bake(c);
    }
    c.used = this.frame;
    c.mesh.visible = true;
  }

  /** Evaluate the chunk's terrain into its bake texture (see planet.vert.glsl). */
  private bake(c: Chunk) {
    const gl = this.gl,
      u = this.bakeMat.uniforms,
      mu = c.mesh.material.uniforms;
    u.uVOct.value = mu.uVOct.value;
    u.uSpacing.value = mu.uSpacing.value;
    u.uQc.value = mu.uQc.value;
    u.uQn.value = mu.uQn.value;
    (u.uLightL.value as THREE.Vector3).copy(this.sun);
    c.sun.copy(this.sun);
    const pts = new THREE.Points(c.mesh.geometry, this.bakeMat);
    pts.frustumCulled = false;
    this.bakeScene.add(pts);
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(c.bake);
    for (const parity of [0, 1]) {
      u.uParity.value = parity;
      this.bakeMat.uniformsNeedUpdate = true;
      gl.render(this.bakeScene, this.bakeCam);
    }
    gl.setRenderTarget(prev);
    this.bakeScene.remove(pts);
  }

  /**
   * The chunk centre's lattice point for each octave (terrain.glsl terrQ): centre · 1.6 · 2.03^i +
   * offset, in double precision, wrapped by `period` for the texture octaves so the shader adds only
   * small offsets: 8 for the noise (the texture tiles every 8 cells), 2312 = 8 × 289 for the crater
   * hash (which repeats every 289).
   */
  private latticeAt(c: number[], period: number) {
    const q = new Float32Array(T_OCT_MAX * 3);
    let k = 1.6;
    for (let i = 0; i < T_OCT_MAX; i++) {
      for (let a = 0; a < 3; a++) {
        const v = c[a] * k + this.off[i * 3 + a];
        q[i * 3 + a] = i >= 3 ? v - Math.floor(v / period) * period : v;
      }
      k *= 2.03;
    }
    return q;
  }

  private free(c: Chunk) {
    c.mesh.geometry.dispose();
    c.mesh.material.dispose();
    c.bake.dispose();
  }

  private build(f: number, L: number, i: number, j: number, bake: THREE.Texture) {
    const n = 2 ** L;
    const s0 = -1 + (2 * i) / n,
      t0 = -1 + (2 * j) / n,
      ds = 2 / n / N;
    const R = this.R;
    const d: number[] = [0, 0, 0];
    const cen = faceDir(f, s0 + ds * (N / 2), t0 + ds * (N / 2), [0, 0, 0]);
    const cx = cen[0] * R,
      cy = cen[1] * R,
      cz = cen[2] * R;
    const V = (N + 1) * (N + 1),
      S = 4 * (N + 1); // skirt vertices, one per edge vertex
    const pos = new Float32Array((V + S) * 3),
      dir = new Float32Array((V + S) * 3),
      grid = new Float32Array((V + S) * 2),
      skirt = new Float32Array(V + S);
    const put = (idx: number, s: number, t: number, gx: number, gy: number) => {
      grid[idx * 2] = gx;
      grid[idx * 2 + 1] = gy;
      faceDir(f, s, t, d);
      pos[idx * 3] = d[0] * R - cx;
      pos[idx * 3 + 1] = d[1] * R - cy;
      pos[idx * 3 + 2] = d[2] * R - cz;
      dir[idx * 3] = d[0];
      dir[idx * 3 + 1] = d[1];
      dir[idx * 3 + 2] = d[2];
    };
    for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) put(y * (N + 1) + x, s0 + ds * x, t0 + ds * y, x, y);
    const idx: number[] = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = y * (N + 1) + x,
          b = a + 1,
          c = a + N + 1,
          e = c + 1;
        idx.push(a, b, e, a, e, c);
      }
    // skirts: each edge's vertices again, lowered in the shader, joined to the edge by a strip
    const edges: number[][] = [[], [], [], []];
    for (let q = 0; q <= N; q++) {
      edges[0].push(q); // bottom (y = 0), left to right
      edges[1].push(q * (N + 1) + N); // right (x = N), bottom to top
      edges[2].push(N * (N + 1) + (N - q)); // top (y = N), right to left
      edges[3].push((N - q) * (N + 1)); // left (x = 0), top to bottom
    }
    let sk = V;
    for (const e of edges) {
      const first = sk;
      for (const v of e) {
        pos.copyWithin(sk * 3, v * 3, v * 3 + 3);
        dir.copyWithin(sk * 3, v * 3, v * 3 + 3);
        grid.copyWithin(sk * 2, v * 2, v * 2 + 2); // a skirt vertex reads its edge vertex's bake
        skirt[sk] = 1;
        sk++;
      }
      // the edges run counter-clockwise around the chunk, so (edge q, edge q+1, skirt q+1) faces out
      for (let q = 0; q < N; q++) idx.push(e[q], first + q + 1, e[q + 1], e[q], first + q, first + q + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
    g.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
    g.setIndex(idx);
    const edge = (R * (Math.PI / 2)) / n,
      spacing = edge / N;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), edge * 0.8 + this.A * 1.2 + spacing * 4);
    // octaves the vertices can show: lattice cells at least ~3 vertex spacings across
    const vOct = Math.max(1, Math.min(17, Math.floor(Math.log(R / (1.6 * 3 * spacing)) / Math.log(2.03)) + 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VS,
      fragmentShader: PLANET_FS,
      defines: { TERRAIN: '' },
      uniforms: {
        ...this.uni,
        uVOct: { value: vOct },
        uSpacing: { value: spacing },
        // deep enough to cover the crack to a coarser neighbour (the octaves it lacks, plus a slope over
        // one spacing), no deeper: skirts are shaded even where hidden (log depth turns off the early
        // depth test), and 4 spacings deep they doubled a grazing periscope view's frame time
        uSkirtD: { value: spacing * SKIRT_SPACINGS + this.A * 0.6 ** vOct },
        uGridW: { value: N + 1 },
        uBake: { value: bake },
        uQc: { value: this.latticeAt(cen, 2312) },
        uQn: { value: this.latticeAt(cen, 8) },
        uUseQc: { value: 1 },
      },
    });
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, cy, cz);
    return m;
  }

  dispose() {
    for (const c of this.chunks.values()) this.free(c);
    this.chunks.clear();
    this.bakeMat.dispose();
    this.root.removeFromParent();
  }
}

const key = (f: number, L: number, i: number, j: number) => `${f}/${L}/${i}/${j}`;
