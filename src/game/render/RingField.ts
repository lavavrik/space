/*
 * A planetary ring up close (sim/rings.ts, docs/rings.md): the rocks themselves.
 *
 *   - Near you (ROCK_TIERS, to 60 km): pebbles, rocks and boulders as instanced, lumpy, star-lit
 *     meshes, laid out on the CPU. Each cell's rocks are generated once and cached in the cell's
 *     co-orbiting frame (offset from the bin's radius, angle within the cell, height, and a
 *     world-space orientation × size); a frame only turns each radial bin by its orbit and subtracts
 *     the camera, in double precision (rings are ~10⁸ m out).
 *   - Beyond (DOT_FIELDS, to 12,000 km): rocks as dots generated entirely on the GPU. Each field is a
 *     RING_GRID × RING_GRID grid of cells centred on the camera, `perCell` candidate dots each; the
 *     vertex shader works out a dot's cell from its index, and its place, size and whether it exists
 *     (the ring's density) from a hash of the cell's global indices, so the same rocks are there
 *     every visit. The CPU only fills a small table per radial bin each frame (DotField.update):
 *     its offset from the camera's radius, the camera's place in its co-orbiting frame, the density.
 *     Dots are sized by how big the rock would look, dimmed below a pixel.
 *
 * So the ring only turns into the disc's smooth band 12,000 km out; the disc fades out inside that
 * while you're in the belt (ring.frag.glsl, uNearFade). Rocks shrink (dots fade) toward the edge of
 * their range instead of popping.
 */
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import { snoise } from '../sim/terrain';
import { DOT_FIELDS, type DotField, hashInts, RING_GRID, RING_HALF_THICK, ROCK_TIERS, ringDensity } from '../sim/rings';
import type { World } from '../types';

/** Rock shapes per mesh tier, and how many of each can be drawn at once per tier. */
const VARIANTS = 4,
  CAPS = [4000, 2500, 800];
/** Above (or below) the belt by this much (m), the disc is back in full around you. */
const FADE_ABOVE = 6000;
/** Cached cells at most (then the cache starts over). */
const CACHE_MAX = 60000;
/** Floats per cached rock: dr, u (angle in the cell, 0…1), z, variant, tint, world orientation × size (9). */
const STRIDE = 14;

const ROCK_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vWP; varying vec3 vCol;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vN = normalize(mat3(m) * normal);
  vec4 wp = m * vec4(position, 1.0);
  vWP = wp.xyz;
  vCol = instanceColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const ROCK_FS = `
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight; uniform vec3 uPC; uniform float uPR; uniform float uExp;
varying vec3 vN; varying vec3 vWP; varying vec3 vCol;
void main(){
  #include <logdepthbuf_fragment>
  vec3 L = normalize(uLight);
  // the planet's shadow: behind it, within its radius of the line to the star
  vec3 toP = vWP - uPC;
  float along = dot(toP, L);
  float sh = (along < 0.0 && length(toP - along * L) < uPR) ? 0.0 : 1.0;
  float d = max(dot(normalize(vN), L), 0.0);
  gl_FragColor = vec4(vCol * (d * sh + 0.004) * uExp, 1.0);
}`;

/**
 * GPU dots. Bin table (uBins, RING_GRID × 2): row 0 = (offset of the bin's radius from the camera's
 * (m), the camera's fractional cell in the bin's co-orbiting frame, density 0…1, the bin's cell angle
 * (rad)); row 1 = (the bin's global radial index, the camera's global angular cell index).
 */
const DOT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uBins;
uniform float uK, uCell, uH, uInner, uRange, uRc, uHc, uPx, uMinR, uMaxR, uSeed, uPR;
uniform vec3 uE1, uE2, uN, uLight, uPC, uColor;
varying vec3 vC;
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
void main(){
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen unless this dot exists
  vC = vec3(0.0);
  int K = int(uK), G = ${RING_GRID};
  int cid = gl_VertexID / K, q = gl_VertexID - cid * K;
  int bi = cid / G, bj = cid - bi * G;
  vec4 A = texelFetch(uBins, ivec2(bi, 0), 0), B = texelFetch(uBins, ivec2(bi, 1), 0);
  if (A.z <= 0.0) return;
  int jrel = bj - G / 2;
  uvec3 hv = pcg3(uvec3(uint(int(B.x) + 1073741824), uint(int(B.y) + jrel + 1073741824), uint(q) + uint(uSeed) * 977u));
  uint s = hv.x ^ hv.y ^ hv.z;
  if (rnd(s) > A.z) return; // the ring's density
  float du = (rnd(s) - 0.5) * uCell, u = rnd(s), zz = (rnd(s) * 2.0 - 1.0) * uH;
  // camera-relative, in the ring's axes: the camera at radius uRc, height uHc, angle 0
  float dphi = (float(jrel) + u - A.y) * A.w;
  float rr = A.x + du;
  float sh2 = sin(0.5 * dphi);
  float x = rr * cos(dphi) - 2.0 * uRc * sh2 * sh2, y = (uRc + rr) * sin(dphi), z = zz - uHc;
  vec3 p = uE1 * x + uE2 * y + uN * z;
  float d = length(p);
  if (d < uInner || d > uRange) return;
  float size = uMinR * pow(uMaxR / uMinR, pow(rnd(s), 2.2));
  float px = 2.0 * size * uPx / d;
  float fade = smoothstep(uInner, uInner * 1.1, d) * smoothstep(uRange, uRange * 0.85, d);
  vec3 L = normalize(uLight);
  vec3 toP = p - uPC;
  float along = dot(toP, L);
  float sh = (along < 0.0 && length(toP - along * L) < uPR) ? 0.0 : 1.0;
  float phase = 0.35 + 0.65 * max(dot(normalize(-p), L), 0.0); // brighter seen from the sun's side
  vC = uColor * (0.5 + 0.6 * rnd(s)) * sh * phase * fade * min(px * px, 1.0);
  gl_PointSize = max(px, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;
const DOT_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uExp;
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vC * uExp, 1.0);
}`;

/** A lumpy rock: an icosphere pushed in and out by noise, faceted. */
function rockGeometry(seed: number, detail: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.32 * snoise(v.x * 1.3 + seed, v.y * 1.3, v.z * 1.3) + 0.12 * snoise(v.x * 3.1, v.y * 3.1 + seed, v.z * 3.1);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

const X = new THREE.Vector3(1, 0, 0),
  Z = new THREE.Vector3(0, 0, 1);
const tmpM = new THREE.Matrix4(),
  tmpQ = new THREE.Quaternion(),
  tmpA = new THREE.Vector3(),
  tmpS = new THREE.Vector3(),
  tmpC = new THREE.Color();

/** The ring and camera as the GPU dot fields need them this frame. */
interface RingFrame {
  b: World;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  n: THREE.Vector3;
  r: number; // camera's distance from the axis (m)
  h: number; // camera's height above the plane (m)
  thC: number; // camera's angle round the ring (rad)
  t: number;
  pxPerRad: number;
}

/** One GPU dot field (see the top). */
class DotLayer {
  readonly points: THREE.Points;
  private readonly bins: THREE.DataTexture;
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly uni: Record<string, THREE.IUniform>;

  constructor(
    private readonly f: DotField,
    shared: Record<string, THREE.IUniform>,
    seed: number,
  ) {
    const G = RING_GRID;
    this.data = new Float32Array(G * 2 * 4);
    this.bins = new THREE.DataTexture(this.data, G, 2, THREE.RGBAFormat, THREE.FloatType);
    this.bins.minFilter = this.bins.magFilter = THREE.NearestFilter;
    this.uni = {
      ...shared,
      uBins: { value: this.bins },
      uK: { value: f.perCell },
      uCell: { value: (2 * f.range) / G },
      uH: { value: RING_HALF_THICK },
      uInner: { value: f.inner },
      uRange: { value: f.range },
      uRc: { value: 0 },
      uHc: { value: 0 },
      uPx: { value: 1 },
      uMinR: { value: f.minR },
      uMaxR: { value: f.maxR },
      uSeed: { value: seed },
      uE1: { value: new THREE.Vector3() },
      uE2: { value: new THREE.Vector3() },
      uN: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color() },
    };
    // one vertex per candidate dot; the shader makes its own position (a 1-float attribute just sets the count)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(G * G * f.perCell), 1));
    const mat = new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, uniforms: this.uni });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  /** Fill the bin table for this frame; false if no part of this field is near the ring. */
  update(fr: RingFrame, seed: number) {
    const { b, r, h } = fr;
    const f = this.f,
      G = RING_GRID,
      cell = (2 * f.range) / G,
      R = b.radius;
    const i0 = Math.floor(r / cell);
    let any = false;
    for (let bi = 0; bi < G; bi++) {
      const gi = i0 - G / 2 + bi;
      const rb = (gi + 0.5) * cell;
      const dR = rb - r;
      let dens = 0;
      if (Math.abs(dR) < f.range && Math.abs(h) < f.range && rb > 0) dens = ringDensity(b, rb / R) / 0.85;
      const o = bi * 4,
        o2 = (G + bi) * 4;
      this.data[o + 2] = dens;
      if (dens <= 0) continue;
      any = true;
      // the camera's place in this bin's co-orbiting frame (double precision here)
      const w = Math.sqrt(b.mu / (rb * rb * rb));
      const dth = cell / rb;
      const phiC = (fr.thC - ((w * fr.t) % (2 * Math.PI))) / dth;
      const jc = Math.floor(phiC);
      this.data[o] = dR;
      this.data[o + 1] = phiC - jc;
      this.data[o + 3] = dth;
      this.data[o2] = gi;
      this.data[o2 + 1] = jc;
    }
    this.points.visible = any;
    if (!any) return false;
    this.bins.needsUpdate = true;
    const u = this.uni;
    u.uRc.value = r;
    u.uHc.value = h;
    u.uPx.value = fr.pxPerRad;
    u.uSeed.value = seed;
    (u.uE1.value as THREE.Vector3).copy(fr.e1);
    (u.uE2.value as THREE.Vector3).copy(fr.e2);
    (u.uN.value as THREE.Vector3).copy(fr.n);
    (u.uColor.value as THREE.Color).copy(b.ring!.color);
    return true;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.bins.dispose();
  }
}

export class RingField {
  readonly group = new THREE.Group();
  /** Instanced meshes per mesh tier and shape. */
  private readonly meshes: THREE.InstancedMesh[][] = [];
  private readonly mat: THREE.ShaderMaterial;
  private readonly dots: DotLayer[];
  readonly uni = { uLight: { value: new THREE.Vector3() }, uPC: { value: new THREE.Vector3() }, uPR: { value: 1 } };
  /** How far the flat disc should fade out around the camera (m; 0 when there are no rocks here). */
  nearFade = 0;
  /** Each cell's rocks (see STRIDE), for the ring they were made for. */
  private readonly cache = new Map<number, Float32Array>();
  private cacheRing: World | null = null;

  constructor(exp: THREE.IUniform) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: ROCK_VS, fragmentShader: ROCK_FS, uniforms: { ...this.uni, uExp: exp } });
    ROCK_TIERS.forEach((tier, ti) => {
      const row: THREE.InstancedMesh[] = [];
      for (let k = 0; k < VARIANTS; k++) {
        const m = new THREE.InstancedMesh(rockGeometry(k * 7.3 + 1.1, tier.detail), this.mat, CAPS[ti]);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPS[ti] * 3), 3);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.count = 0;
        row.push(m);
        this.group.add(m);
      }
      this.meshes.push(row);
    });
    this.dots = DOT_FIELDS.map((f, k) => new DotLayer(f, { ...this.uni, uExp: exp }, k));
    for (const d of this.dots) this.group.add(d.points);
  }

  /** A cell's rocks, generated on first use (deterministic from the ring's seed and the cell). */
  private cell(b: World, ti: number, i: number, jj: number, k: number, z0: number, z1: number, dens: number) {
    const key = ((ti * 64 + (k + 32)) * 4194304 + jj) * 1048576 + (i & 0xfffff);
    let c = this.cache.get(key);
    if (c) return c;
    const tier = ROCK_TIERS[ti];
    const rnd = mulberry32(hashInts(ti, i, jj, k, Math.floor(b.ring!.seed * 1e4)));
    const cnt = Math.floor(tier.perCell * dens * ((z1 - z0) / tier.cell) + rnd());
    c = new Float32Array(cnt * STRIDE);
    for (let q = 0; q < cnt; q++) {
      const o = q * STRIDE;
      c[o] = (rnd() - 0.5) * tier.cell; // radius offset from the bin's
      c[o + 1] = rnd(); // angle within the cell
      c[o + 2] = z0 + rnd() * (z1 - z0);
      const size = tier.minR * Math.pow(tier.maxR / tier.minR, Math.pow(rnd(), 2.2));
      c[o + 3] = Math.floor(rnd() * VARIANTS);
      c[o + 4] = 0.5 + 0.6 * rnd(); // tint
      // orientation × squashed size, in world axes (the ring's frame is fixed)
      tmpA.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      tmpQ.setFromAxisAngle(tmpA, rnd() * 6.28);
      tmpS.set(size * (0.6 + 0.4 * rnd()), size * (0.55 + 0.45 * rnd()), size);
      const m = tmpM.compose(tmpA.set(0, 0, 0), tmpQ, tmpS).elements;
      c.set([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], o + 5);
    }
    if (this.cache.size > CACHE_MAX) this.cache.clear();
    this.cache.set(key, c);
    return c;
  }

  /**
   * Show the rocks of `b`'s ring around the camera. `rel` is the planet's centre relative to the
   * camera (m), `n` the ring's normal (the planet's axis), `light` the direction to the star, `t` the
   * sim time, `pxPerRad` the view's pixels per radian (for the dots' sizes). Returns whether any
   * part of the ring is close enough to have rocks.
   */
  update(b: World, rel: THREE.Vector3, n: THREE.Vector3, light: THREE.Vector3, t: number, pxPerRad: number) {
    const ring = b.ring!;
    const R = b.radius;
    if (this.cacheRing !== b) {
      this.cache.clear();
      this.cacheRing = b;
    }
    const far = DOT_FIELDS[DOT_FIELDS.length - 1].range;
    // the camera in the ring's frame (double precision): height above the plane, radius, angle
    const cx = -rel.x,
      cy = -rel.y,
      cz = -rel.z;
    const h = cx * n.x + cy * n.y + cz * n.z;
    const px = cx - h * n.x,
      py = cy - h * n.y,
      pz = cz - h * n.z;
    const r = Math.hypot(px, py, pz);
    const counts = this.meshes.map(() => new Array(VARIANTS).fill(0));
    this.nearFade = 0;
    const active = Math.abs(h) < far + RING_HALF_THICK && r > ring.inner * R - far && r < ring.outer * R + far;
    for (const d of this.dots) d.points.visible = false;
    if (active) {
      // the disc stands for the rocks too small or far to draw: inside the belt the drawn rocks
      // replace it around you; from well above or below it, it shows again (or you'd look down
      // through a hole of sparse boulders)
      const above = Math.max(0, Math.abs(h) - RING_HALF_THICK);
      this.nearFade = far * 0.9 * Math.max(0, 1 - above / FADE_ABOVE);
      // in-plane axes fixed to the ring (not the camera, or the rocks would slide as you move)
      const e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Z).normalize();
      const e2 = new THREE.Vector3().crossVectors(n, e1);
      const c1 = px * e1.x + py * e1.y + pz * e1.z,
        c2 = px * e2.x + py * e2.y + pz * e2.z;
      const thC = Math.atan2(c2, c1); // the camera's angle round the ring
      this.uni.uLight.value.copy(light);
      this.uni.uPC.value.copy(rel);
      this.uni.uPR.value = R;
      // the GPU dots work in axes turned to the camera's angle (it sits at angle 0 there)
      const d1 = e1.clone().multiplyScalar(Math.cos(thC)).addScaledVector(e2, Math.sin(thC));
      const d2 = new THREE.Vector3().crossVectors(n, d1);
      const fr: RingFrame = { b, e1: d1, e2: d2, n, r, h, thC, t, pxPerRad };
      const seed = Math.floor(ring.seed * 1e4);
      this.dots.forEach((d, k) => d.update(fr, seed + k * 7919));
      ROCK_TIERS.forEach((tier, ti) => {
        const C = tier.cell,
          range = tier.range;
        const iR = Math.ceil(range / C);
        const i0 = Math.floor(r / C);
        const kLo = Math.floor(-RING_HALF_THICK / C),
          kHi = Math.floor(RING_HALF_THICK / C);
        for (let i = i0 - iR; i <= i0 + iR; i++) {
          const rb = (i + 0.5) * C;
          const dr = Math.abs(rb - r) - C / 2;
          if (dr > range) continue;
          const dens = ringDensity(b, rb / R) / 0.85;
          if (dens < 0.01) continue;
          // this radial bin turns at the circular orbit rate at its radius
          const w = Math.sqrt(b.mu / (rb * rb * rb));
          const wt = (w * t) % (2 * Math.PI);
          const nth = Math.max(1, Math.floor((2 * Math.PI * rb) / C));
          const dth = (2 * Math.PI) / nth;
          const jc = Math.floor((thC - wt) / dth); // the camera, in this bin's co-orbiting frame
          const arc = Math.sqrt(Math.max(0, range * range - Math.max(0, dr) ** 2));
          const dj = Math.ceil(arc / (rb * dth)) + 1;
          for (let j = jc - dj; j <= jc + dj; j++) {
            const jj = ((j % nth) + nth) % nth;
            for (let k = kLo; k <= kHi; k++) {
              const z0 = Math.max(k * C, -RING_HALF_THICK),
                z1 = Math.min((k + 1) * C, RING_HALF_THICK);
              if (z1 <= z0) continue;
              const cell = this.cell(b, ti, i, jj, k, z0, z1, dens);
              for (let o = 0; o < cell.length; o += STRIDE) {
                const rr = rb + cell[o];
                const phi = (j + cell[o + 1]) * dth + wt;
                // camera-relative, in (e1, e2, n)
                const ax = rr * Math.cos(phi) - c1,
                  ay = rr * Math.sin(phi) - c2,
                  az = cell[o + 2] - h;
                const dist = Math.hypot(ax, ay, az);
                if (dist > range) continue;
                const variant = cell[o + 3];
                const mesh = this.meshes[ti][variant];
                const cnt = counts[ti][variant];
                if (cnt >= CAPS[ti]) continue;
                // shrink away toward the edge of the tier's range
                const edge = Math.min(1, (range - dist) / (range * 0.15));
                const a = mesh.instanceMatrix.array as Float32Array;
                const p = cnt * 16;
                for (let e = 0; e < 3; e++) {
                  a[p + e] = cell[o + 5 + e] * edge;
                  a[p + 4 + e] = cell[o + 8 + e] * edge;
                  a[p + 8 + e] = cell[o + 11 + e] * edge;
                }
                a[p + 3] = a[p + 7] = a[p + 11] = 0;
                a[p + 12] = e1.x * ax + e2.x * ay + n.x * az;
                a[p + 13] = e1.y * ax + e2.y * ay + n.y * az;
                a[p + 14] = e1.z * ax + e2.z * ay + n.z * az;
                a[p + 15] = 1;
                mesh.setColorAt(cnt, tmpC.copy(ring.color).multiplyScalar(cell[o + 4]));
                counts[ti][variant] = cnt + 1;
              }
            }
          }
        }
      });
    }
    this.meshes.forEach((row, ti) =>
      row.forEach((m, k) => {
        m.count = counts[ti][k];
        m.visible = m.count > 0;
        if (m.count) {
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
      }),
    );
    return active;
  }

  dispose() {
    for (const row of this.meshes)
      for (const m of row) {
        m.geometry.dispose();
        m.dispose();
      }
    this.mat.dispose();
    for (const d of this.dots) d.dispose();
  }
}
