/*
 * A planetary ring up close (sim/rings.ts, docs/rings.md): the rocks themselves, all generated on
 * the GPU so there can be a lot of them.
 *
 * Each layer (ROCK_LAYERS) is a grid of cells centred on the camera, in the ring's co-orbiting
 * frame, with a few candidate rocks per cell. The vertex shader works out a rock's cell from its
 * instance (or vertex) index, and from a hash of the cell's global indices its place, size, tint,
 * orientation and whether it's there at all (the ring's density), so the same rocks are there every
 * visit. Meshes are lumpy icospheres (faceted from screen-space derivatives), specks are points sized
 * by how big the rock would look (at most 2 px, keeping its light). The CPU only fills a small table
 * per radial bin each frame (Layer.update): the bin's offset from the camera's radius, the camera's
 * place in the bin's co-orbiting frame (in double precision: rings are ~10⁸ m out), the density.
 * Each radial bin turns at its own orbit rate, so the ring shears like a real one.
 *
 * Layers fade in and out over wide bands (the boulder specks come in as the boulder meshes shrink
 * away), so no edge shows; the ring's flat disc takes over past DISC_FROM while you're in the belt
 * (ring.frag.glsl, uNearFade), and fully again once you're well above or below it.
 */
import { THREE } from '../lib/three';
import { DISC_FROM, RING_HALF_THICK, ROCK_LAYERS, type RockLayer, ringDensity } from '../sim/rings';
import type { World } from '../types';

/** Above (or below) the belt by this much (m), the disc is back in full around you. */
const FADE_ABOVE = 6000;

/**
 * A rock from its index (shared by meshes and specks). Bin table (uBins, grid × 2): row 0 = (offset
 * of the bin's radius from the camera's (m), the camera's fractional cell in the bin's co-orbiting
 * frame, density 0…1, the bin's cell angle (rad)); row 1 = (the bin's global radial index, the
 * camera's angular cell index round the bin, and the number of cells round it, each split in two
 * (÷ 4096, remainder) as they pass float32's exact integers at a giant's outer rings). A whole number of cells
 * goes round each bin, and angular indices wrap at it: then the bin's phase wrapping by a full turn
 * (every orbit; every few seconds under time warp) leaves every rock where it was. Before, a turn was
 * a fraction of a cell off, and each wrap swapped the bin's rocks for a different set.
 */
const ROCK_GLSL = `
uniform sampler2D uBins;
uniform float uK, uCell, uH, uInner, uFadeTo, uRange, uOut, uRc, uHc, uMinR, uMaxR, uSeed, uCutMin, uCutMax;
uniform vec3 uE1, uE2, uN, uColor;
uvec3 pcg3(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float rnd(inout uint s){
  s = s * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return float((w >> 22u) ^ w) / 4294967295.0;
}
// the rock with this index: false if there's none; else its camera-relative place, radius, tint,
// fade (0…1), and the random stream for more
bool ringRock(int id, out vec3 p, out float size, out float tint, out float fade, out uint s){
  int K = int(uK);
  int cid = id / K, q = id - cid * K;
  // a fine-mesh layer draws only the central WINDOW × WINDOW cells of the grid (the same rocks)
  int li = cid / WINDOW, lj = cid - li * WINDOW;
  int bi = (GRID - WINDOW) / 2 + li, bj = (GRID - WINDOW) / 2 + lj;
  vec4 A = texelFetch(uBins, ivec2(bi, 0), 0), B = texelFetch(uBins, ivec2(bi, 1), 0), C = texelFetch(uBins, ivec2(bi, 2), 0);
  if (A.z <= 0.0) return false;
  int jrel = bj - GRID / 2;
  int nth = int(C.x) * 4096 + int(C.y), jc = int(B.y) * 4096 + int(B.z);
  int jj = (jc + jrel) % nth;
  if (jj < 0) jj += nth;
  uvec3 hv = pcg3(uvec3(uint(int(B.x) + 1073741824), uint(jj), uint(q) + uint(uSeed) * 977u));
  s = hv.x ^ hv.y ^ hv.z;
  if (rnd(s) > A.z) return false; // the ring's density
  float du = (rnd(s) - 0.5) * uCell, u = rnd(s), zz = (rnd(s) * 2.0 - 1.0) * uH;
  // in the ring's axes turned to the camera (it's at radius uRc, height uHc, angle 0)
  float dphi = (float(jrel) + u - A.y) * A.w;
  float rr = A.x + du;
  float sh2 = sin(0.5 * dphi);
  p = uE1 * (rr * cos(dphi) - 2.0 * uRc * sh2 * sh2) + uE2 * ((uRc + rr) * sin(dphi)) + uN * (zz - uHc);
  float d = length(p);
  if (d > uRange || d < uInner || d < uCutMin || d > uCutMax) return false; // (cuts: which mesh draws it)
  size = uMinR * pow(uMaxR / uMinR, pow(rnd(s), 2.2));
  tint = 0.5 + 0.6 * rnd(s);
  fade = (uFadeTo > 0.0 ? smoothstep(uInner, uFadeTo, d) : 1.0) * smoothstep(uRange, uRange * uOut, d);
  return true;
}
// the planet's shadow: behind it, within its radius of the line to the star
uniform vec3 uLight, uPC; uniform float uPR;
float ringShadow(vec3 p){
  vec3 L = normalize(uLight), toP = p - uPC;
  float along = dot(toP, L);
  return (along < 0.0 && length(toP - along * L) < uPR) ? 0.0 : 1.0;
}`;

/**
 * Rock meshes. Every rock has its own shape: the base icosphere's directions pushed out by three
 * octaves of 3D noise at a per-rock offset (uNoise3D), then squashed and turned, with normals from the
 * shape itself (finite differences on the sphere). The fragment shader shades that smoothly (no
 * surface noise) like regolith: Lommel–Seeliger (the Moon's flat-looking disc) mixed with Lambert,
 * plus light from the giant it circles (planetshine).
 */
const ROCK_NOISE = `
uniform highp sampler3D uNoise3D;
float tn(vec3 p){ return textureLod(uNoise3D, p * 0.125, 0.0).r * 2.0 - 1.0; }
`;
const MESH_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
${ROCK_GLSL}
${ROCK_NOISE}
varying vec3 vWP; varying vec3 vN; varying vec3 vCol; varying float vSh;
vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float shape(vec3 d, vec3 o){ return 1.0 + 0.30 * tn(d * 0.9 + o) + 0.14 * tn(d * 2.1 + o.yzx) + 0.06 * tn(d * 4.7 + o.zxy); }
void main(){
  vec3 c; float size, tint, fade; uint s;
  if (!ringRock(gl_InstanceID, c, size, tint, fade, s) || fade <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen: no rock here
    return;
  }
  // a random orientation (uniform quaternion), an elongation, and its own shape
  float u1 = rnd(s), u2 = rnd(s) * 6.2831853, u3 = rnd(s) * 6.2831853;
  vec4 q = vec4(sqrt(1.0 - u1) * sin(u2), sqrt(1.0 - u1) * cos(u2), sqrt(u1) * sin(u3), sqrt(u1) * cos(u3));
  vec3 sc = vec3(1.0, 0.55 + 0.4 * rnd(s), 0.45 + 0.45 * rnd(s)) * size * fade; // shrinks away with the fade
  vec3 o = vec3(rnd(s), rnd(s), rnd(s)) * 8.0;
  vec3 d = normalize(position);
  vec3 p0 = d * shape(d, o);
#ifdef FINE
  // up close: normals from the shape itself (finite differences on the sphere)
  vec3 t1 = normalize(cross(d, abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), t2 = cross(d, t1);
  vec3 d1 = normalize(d + 0.02 * t1), d2 = normalize(d + 0.02 * t2);
  vec3 n = normalize(cross(d1 * shape(d1, o) - p0, d2 * shape(d2, o) - p0));
  if (dot(n, d) < 0.0) n = -n;
#else
  // far off (a few pixels): the sphere's normal will do, a third of the noise lookups
  vec3 n = d;
#endif
  vWP = c + qrot(q, p0 * sc);
  vN = qrot(q, normalize(n / sc));
  vCol = uColor * tint;
  vSh = ringShadow(c);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWP, 1.0);
  #include <logdepthbuf_vertex>
}`;
const MESH_FS = `
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight, uPC; uniform float uPR, uPlanetA, uExp;
varying vec3 vWP; varying vec3 vN; varying vec3 vCol; varying float vSh;
void main(){
  #include <logdepthbuf_fragment>
  // smooth shading from the rock's shape alone: no surface noise (fine bump relief looked like a
  // planet's ground grain and streaked under the periscope)
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(uLight), V = normalize(-vWP);
  float mu0 = max(dot(N, L), 0.0), mu = max(dot(N, V), 0.05);
  float sun = mix(mu0, 2.0 * mu0 / (mu0 + mu), 0.6) * vSh; // Lommel–Seeliger, a little Lambert
  // planetshine: the giant's sunlit face, seen from here (rough), falling off with distance
  vec3 toPl = uPC - vWP;
  float dp = length(toPl);
  vec3 Lp = toPl / dp;
  float shine = uPlanetA * (0.5 + 0.5 * dot(-Lp, L)) * (uPR * uPR) / (dp * dp) * max(dot(N, Lp), 0.0);
  gl_FragColor = vec4(vCol * (sun + shine + 0.002) * uExp, 1.0);
}`;

const DOT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
${ROCK_GLSL}
uniform float uPx;
varying vec3 vC;
void main(){
  vec3 p; float size, tint, fade; uint s;
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vC = vec3(0.0);
  if (!ringRock(gl_VertexID, p, size, tint, fade, s)) return;
  float px = 2.0 * size * uPx / length(p);
  float phase = 0.35 + 0.65 * max(dot(normalize(-p), normalize(uLight)), 0.0); // brighter seen from the sun's side
  // a speck: never wider than 2 px (bigger dots read as flat discs), keeping the light of the rock
  // it stands for; below a pixel, dimmed by its share of one
  float light = px < 1.0 ? px * px : min(max(px * px / 4.0, 1.0), 8.0);
  vC = uColor * tint * ringShadow(p) * phase * fade * light * 0.5; // (a lit rock shows about half its disc)
  gl_PointSize = clamp(px, 1.0, 2.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;
const DOT_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uExp;
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vC * uExp, 1.0);
}`;

/** A unit icosphere, welded (the vertex shader shapes each rock from it: the instances are many, so vertex count matters). */
function sphereGeometry(detail: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const verts: number[] = [],
    index: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = verts.length / 3;
      map.set(k, j);
      verts.push(p.getX(i), p.getY(i), p.getZ(i));
    }
    index.push(j);
  }
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  return out;
}

/** The ring and camera as the layers need them this frame. */
interface RingFrame {
  b: World;
  e1: THREE.Vector3; // in-plane axes turned so the camera is at angle 0
  e2: THREE.Vector3;
  n: THREE.Vector3;
  r: number; // camera's distance from the axis (m)
  h: number; // camera's height above the plane (m)
  thC: number; // camera's angle round the ring in the ring's fixed axes (rad)
  t: number;
  pxPerRad: number;
}

/** One layer of rocks (see the top). */
class Layer {
  readonly object: THREE.Object3D;
  private readonly bins: THREE.DataTexture;
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly uni: Record<string, THREE.IUniform>;

  /**
   * `lod`: which of the layer's detail levels this copy draws: its rocks between `from` and `to` (m)
   * with a sphere of that subdivision. Every copy sees the same cells, so the same rocks.
   */
  constructor(
    private readonly L: RockLayer,
    shared: Record<string, THREE.IUniform>,
    private readonly seedK: number,
    lod: { detail: number; from: number; to: number } = { detail: L.detail, from: 0, to: 1e30 },
  ) {
    const G = L.grid;
    this.data = new Float32Array(G * 3 * 4);
    this.bins = new THREE.DataTexture(this.data, G, 3, THREE.RGBAFormat, THREE.FloatType);
    this.bins.minFilter = this.bins.magFilter = THREE.NearestFilter;
    const mesh = L.detail >= 0;
    const cell = (2 * L.range) / G;
    // a nearer copy covers just enough central cells to reach its cut (and a cell to spare)
    const window = lod.to < 1e29 ? Math.min(G, 2 * Math.ceil(lod.to / cell) + 2) : G;
    this.uni = {
      ...shared,
      uBins: { value: this.bins },
      uK: { value: L.perCell },
      uCell: { value: (2 * L.range) / G },
      uH: { value: RING_HALF_THICK },
      uInner: { value: L.inner },
      uFadeTo: { value: L.fadeTo },
      uRange: { value: L.range },
      uOut: { value: mesh ? 0.5 : 0.85 }, // meshes shrink away over the outer half of their range
      uRc: { value: 0 },
      uHc: { value: 0 },
      uMinR: { value: L.minR },
      uMaxR: { value: L.maxR },
      uSeed: { value: 0 },
      uE1: { value: new THREE.Vector3() },
      uE2: { value: new THREE.Vector3() },
      uN: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color() },
      uPx: { value: 1 },
      uCutMin: { value: lod.from },
      uCutMax: { value: lod.to },
    };
    const defines: Record<string, number | string> = { GRID: G, WINDOW: window };
    if (lod.detail >= 1) defines.FINE = ''; // normals from the shape itself (not for the tiny far ones)
    const count = window * window * L.perCell;
    if (mesh) {
      const base = sphereGeometry(lod.detail);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', base.attributes.position);
      g.setIndex(base.index);
      g.instanceCount = count;
      this.object = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: MESH_VS, fragmentShader: MESH_FS, uniforms: this.uni, defines }));
    } else {
      // one vertex per candidate speck; the shader makes its own position (a 1-float attribute just sets the count)
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count), 1));
      this.object = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, uniforms: this.uni, defines }));
    }
    this.object.frustumCulled = false;
  }

  /** Fill the bin table for this frame; hides the layer if no part of it is near the ring. */
  update(fr: RingFrame, seed: number) {
    const { b, r, h } = fr;
    const L = this.L,
      G = L.grid,
      cell = (2 * L.range) / G,
      R = b.radius;
    const i0 = Math.floor(r / cell);
    let any = false;
    for (let bi = 0; bi < G; bi++) {
      const gi = i0 - G / 2 + bi;
      const rb = (gi + 0.5) * cell;
      const dR = rb - r;
      let dens = 0;
      if (Math.abs(dR) < L.range && Math.abs(h) < L.range + RING_HALF_THICK && rb > 0) dens = ringDensity(b, rb / R) / 0.85;
      const o = bi * 4,
        o2 = (G + bi) * 4,
        o3 = (2 * G + bi) * 4;
      this.data[o + 2] = dens;
      if (dens <= 0) continue;
      any = true;
      // the camera's place in this bin's co-orbiting frame (double precision here)
      const w = Math.sqrt(b.mu / (rb * rb * rb));
      const nth = Math.max(1, Math.round((2 * Math.PI * rb) / cell)); // a whole number of cells round (see the top)
      const dth = (2 * Math.PI) / nth;
      const phiC = (fr.thC - ((w * fr.t) % (2 * Math.PI))) / dth;
      const jc = Math.floor(phiC);
      this.data[o] = dR;
      this.data[o + 1] = phiC - jc;
      this.data[o + 3] = dth;
      const jm = ((jc % nth) + nth) % nth; // the camera's cell round the bin, wrapped
      this.data[o2] = gi;
      this.data[o2 + 1] = Math.floor(jm / 4096);
      this.data[o2 + 2] = jm % 4096;
      this.data[o3] = Math.floor(nth / 4096);
      this.data[o3 + 1] = nth % 4096;
    }
    this.object.visible = any;
    if (!any) return;
    this.bins.needsUpdate = true;
    const u = this.uni;
    u.uRc.value = r;
    u.uHc.value = h;
    u.uPx.value = fr.pxPerRad;
    u.uSeed.value = seed + this.seedK * 7919;
    (u.uE1.value as THREE.Vector3).copy(fr.e1);
    (u.uE2.value as THREE.Vector3).copy(fr.e2);
    (u.uN.value as THREE.Vector3).copy(fr.n);
    (u.uColor.value as THREE.Color).copy(b.ring!.color);
  }

  dispose() {
    const o = this.object as THREE.Mesh;
    o.geometry.dispose();
    (o.material as THREE.Material).dispose();
    this.bins.dispose();
  }
}

const X = new THREE.Vector3(1, 0, 0),
  Z = new THREE.Vector3(0, 0, 1);

export class RingField {
  readonly group = new THREE.Group();
  private readonly layers: Layer[];
  readonly uni = { uLight: { value: new THREE.Vector3() }, uPC: { value: new THREE.Vector3() }, uPR: { value: 1 }, uPlanetA: { value: 0.3 } };
  /** How far the flat disc should fade out around the camera (m; 0 when there are no rocks here). */
  nearFade = 0;

  constructor(exp: THREE.IUniform, noise: THREE.Texture) {
    const shared = { ...this.uni, uExp: exp, uNoise3D: { value: noise } };
    this.layers = [];
    ROCK_LAYERS.forEach((L, k) => {
      // one copy per detail level, each drawing its band of distance (nearest finest)
      let from = 0;
      for (const lv of L.lods ?? []) {
        this.layers.push(new Layer(L, shared, k, { detail: lv.detail, from, to: lv.cut }));
        from = lv.cut;
      }
      this.layers.push(new Layer(L, shared, k, { detail: L.detail, from, to: 1e30 }));
    });
    for (const l of this.layers) this.group.add(l.object);
  }

  /**
   * Show the rocks of `b`'s ring around the camera. `rel` is the planet's centre relative to the
   * camera (m), `n` the ring's normal (the planet's axis), `light` the direction to the star, `t` the
   * sim time, `pxPerRad` the view's pixels per radian (for the specks' sizes). Returns whether any
   * part of the ring is close enough to have rocks.
   */
  update(b: World, rel: THREE.Vector3, n: THREE.Vector3, light: THREE.Vector3, t: number, pxPerRad: number) {
    const ring = b.ring!;
    const R = b.radius;
    const far = ROCK_LAYERS[ROCK_LAYERS.length - 1].range;
    // the camera in the ring's frame (double precision): height above the plane, radius, angle
    const cx = -rel.x,
      cy = -rel.y,
      cz = -rel.z;
    const h = cx * n.x + cy * n.y + cz * n.z;
    const px = cx - h * n.x,
      py = cy - h * n.y,
      pz = cz - h * n.z;
    const r = Math.hypot(px, py, pz);
    this.nearFade = 0;
    const active = Math.abs(h) < far + RING_HALF_THICK && r > ring.inner * R - far && r < ring.outer * R + far;
    if (!active) {
      for (const l of this.layers) l.object.visible = false;
      return false;
    }
    // the disc stands for the rocks too small or far to draw: inside the belt the rocks replace it
    // around you; from well above or below it, it shows again (or you'd look down through a hole)
    const above = Math.max(0, Math.abs(h) - RING_HALF_THICK);
    this.nearFade = DISC_FROM * Math.max(0, 1 - above / FADE_ABOVE);
    // in-plane axes fixed to the ring, then turned to the camera's angle round it
    const e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Z).normalize();
    const e2 = new THREE.Vector3().crossVectors(n, e1);
    const thC = Math.atan2(px * e2.x + py * e2.y + pz * e2.z, px * e1.x + py * e1.y + pz * e1.z);
    const d1 = e1.clone().multiplyScalar(Math.cos(thC)).addScaledVector(e2, Math.sin(thC));
    const d2 = new THREE.Vector3().crossVectors(n, d1);
    this.uni.uLight.value.copy(light);
    this.uni.uPC.value.copy(rel);
    this.uni.uPR.value = R;
    this.uni.uPlanetA.value = b.albedo;
    const fr: RingFrame = { b, e1: d1, e2: d2, n, r, h, thC, t, pxPerRad };
    const seed = Math.floor(ring.seed * 1e4);
    for (const l of this.layers) l.update(fr, seed);
    return true;
  }

  dispose() {
    for (const l of this.layers) l.dispose();
  }
}
