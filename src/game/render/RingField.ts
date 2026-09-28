/*
 * A planetary ring up close (sim/rings.ts, docs/rings.md): the rocks themselves, generated around
 * the camera from the ring's cells. Tiers (ROCK_TIERS): pebbles, rocks and boulders as instanced,
 * lumpy, star-lit meshes (coarser shapes for the smaller tiers), and beyond the boulders a far field
 * of rocks as points out to 250 km, sized by how big they'd look (dimmed below a pixel), so the
 * disc's grey band only starts where even the biggest rock is under a pixel. Rocks shrink (points
 * fade) toward the edge of their tier's range instead of popping. The ring's flat disc fades out
 * inside the far field while you're in the belt (ring.frag.glsl, uNearFade).
 *
 * Each cell's rocks are generated once and cached in the cell's co-orbiting frame (offset from the
 * bin's radius, angle within the cell, height, and a world-space orientation × size); a frame only
 * turns each radial bin by its orbit and subtracts the camera. Positions are worked out in double
 * precision relative to the planet (rings are ~10⁸ m out) and handed to the GPU relative to the camera.
 */
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import { snoise } from '../sim/terrain';
import { hashInts, RING_HALF_THICK, ROCK_TIERS, ringDensity } from '../sim/rings';
import type { World } from '../types';

/** Rock shapes per mesh tier, how many of each can be drawn at once per tier, and far-field points. */
const VARIANTS = 4,
  CAPS = [4000, 2500, 800],
  POINTS_CAP = 30000;
/** Above (or below) the belt by this much (m), the disc is back in full around you. */
const FADE_ABOVE = 6000;
/** Cached cells at most (then the cache starts over). */
const CACHE_MAX = 60000;
/** Floats per cached rock: dr, u (angle in the cell, 0…1), z, then a mesh rock's variant, tint and
 * world orientation × size (9), or a point's radius and tint. */
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

/** Far-field rocks: a round dot of the rock's apparent size (at least a pixel, dimmed below it). */
const PT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize; attribute vec3 aColor;
uniform vec3 uLight; uniform vec3 uPC; uniform float uPR;
varying vec3 vC;
void main(){
  vec3 L = normalize(uLight);
  vec3 toP = position - uPC;
  float along = dot(toP, L);
  float sh = (along < 0.0 && length(toP - along * L) < uPR) ? 0.0 : 1.0;
  // lit from the star's side: brighter seen from the sun's side (a rough phase)
  float phase = 0.35 + 0.65 * max(dot(normalize(-position), L), 0.0);
  vC = aColor * sh * phase * min(aSize * aSize, 1.0);
  gl_PointSize = max(aSize, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const PT_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uExp;
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
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

export class RingField {
  readonly group = new THREE.Group();
  /** Instanced meshes per mesh tier and shape. */
  private readonly meshes: THREE.InstancedMesh[][] = [];
  private readonly mat: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly ptMat: THREE.ShaderMaterial;
  readonly uni = { uLight: { value: new THREE.Vector3() }, uPC: { value: new THREE.Vector3() }, uPR: { value: 1 } };
  /** How far the flat disc should fade out around the camera (m; 0 when there are no rocks here). */
  nearFade = 0;
  /** Each cell's rocks (see STRIDE), for the ring they were made for. */
  private readonly cache = new Map<number, Float32Array>();
  private cacheRing: World | null = null;

  constructor(exp: THREE.IUniform) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: ROCK_VS, fragmentShader: ROCK_FS, uniforms: { ...this.uni, uExp: exp } });
    ROCK_TIERS.forEach((tier, ti) => {
      if (tier.detail < 0) return;
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
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POINTS_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(POINTS_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(POINTS_CAP), 1).setUsage(THREE.DynamicDrawUsage));
    this.ptMat = new THREE.ShaderMaterial({ vertexShader: PT_VS, fragmentShader: PT_FS, uniforms: { ...this.uni, uExp: exp } });
    this.points = new THREE.Points(pg, this.ptMat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
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
      c[o + 4] = 0.5 + 0.6 * rnd(); // tint
      if (tier.detail < 0) {
        c[o + 3] = size;
        continue;
      }
      c[o + 3] = Math.floor(rnd() * VARIANTS);
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
   * sim time, `pxPerRad` the view's pixels per radian (for the far field's dot sizes). Returns
   * whether any part of the ring is close enough to have rocks.
   */
  update(b: World, rel: THREE.Vector3, n: THREE.Vector3, light: THREE.Vector3, t: number, pxPerRad: number) {
    const ring = b.ring!;
    const R = b.radius;
    if (this.cacheRing !== b) {
      this.cache.clear();
      this.cacheRing = b;
    }
    const far = ROCK_TIERS[ROCK_TIERS.length - 1].range;
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
    let np = 0;
    this.nearFade = 0;
    const active = Math.abs(h) < far + RING_HALF_THICK && r > ring.inner * R - far && r < ring.outer * R + far;
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
      const pPos = this.points.geometry.attributes.position.array as Float32Array,
        pCol = this.points.geometry.attributes.aColor.array as Float32Array,
        pSize = this.points.geometry.attributes.aSize.array as Float32Array;
      const boulders = ROCK_TIERS[2].range;
      ROCK_TIERS.forEach((tier, ti) => {
        const C = tier.cell,
          range = tier.range;
        const isPt = tier.detail < 0;
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
                const wx = e1.x * ax + e2.x * ay + n.x * az,
                  wy = e1.y * ax + e2.y * ay + n.y * az,
                  wz = e1.z * ax + e2.z * ay + n.z * az;
                // shrink away (or fade, for points) toward the edge of the tier's range
                const edge = Math.min(1, (range - dist) / (range * 0.15));
                const tint = cell[o + 4];
                if (isPt) {
                  if (dist < boulders * 0.9 || np >= POINTS_CAP) continue; // the boulders have it
                  const inner = Math.min(1, (dist - boulders * 0.9) / (boulders * 0.1));
                  pPos[np * 3] = wx;
                  pPos[np * 3 + 1] = wy;
                  pPos[np * 3 + 2] = wz;
                  pCol[np * 3] = ring.color.r * tint * edge * inner;
                  pCol[np * 3 + 1] = ring.color.g * tint * edge * inner;
                  pCol[np * 3 + 2] = ring.color.b * tint * edge * inner;
                  pSize[np] = (2 * cell[o + 3] * pxPerRad) / dist;
                  np++;
                  continue;
                }
                const variant = cell[o + 3];
                const mesh = this.meshes[ti][variant];
                const cnt = counts[ti][variant];
                if (cnt >= CAPS[ti]) continue;
                const a = mesh.instanceMatrix.array as Float32Array;
                const p = cnt * 16;
                a[p] = cell[o + 5] * edge;
                a[p + 1] = cell[o + 6] * edge;
                a[p + 2] = cell[o + 7] * edge;
                a[p + 3] = 0;
                a[p + 4] = cell[o + 8] * edge;
                a[p + 5] = cell[o + 9] * edge;
                a[p + 6] = cell[o + 10] * edge;
                a[p + 7] = 0;
                a[p + 8] = cell[o + 11] * edge;
                a[p + 9] = cell[o + 12] * edge;
                a[p + 10] = cell[o + 13] * edge;
                a[p + 11] = 0;
                a[p + 12] = wx;
                a[p + 13] = wy;
                a[p + 14] = wz;
                a[p + 15] = 1;
                mesh.setColorAt(cnt, tmpC.copy(ring.color).multiplyScalar(tint));
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
    const pg = this.points.geometry;
    pg.setDrawRange(0, np);
    this.points.visible = np > 0;
    if (np) for (const at of ['position', 'aColor', 'aSize']) pg.attributes[at].needsUpdate = true;
    return active;
  }

  dispose() {
    for (const row of this.meshes)
      for (const m of row) {
        m.geometry.dispose();
        m.dispose();
      }
    this.mat.dispose();
    this.points.geometry.dispose();
    this.ptMat.dispose();
  }
}
