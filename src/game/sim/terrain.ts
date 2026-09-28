/*
 * Planet terrain: one height function shared by the renderer (GLSL, render/shaders/terrain.glsl)
 * and the simulation (this file), so what you see is what you land on. See docs/terrain.md.
 *
 * Height is the planet shader's fBm `h` (the same noise that paints continents, seas and ice), in
 * the world's own frame (tilted and spinning, like its mesh). Octave i samples
 *     q_i = dir · 1.6 · 2.03^i + O_i
 * the same chain as the shader's `fbmF(sp)` (sp = 1.6·dir + seed offset, each octave ×2.03 plus a
 * fixed shift), with the offsets O_i worked out here in double precision. That fBm gives the
 * continents; on its own it's far too smooth up close (every slope ~1%), so mountain ranges are
 * added: ridged noise (sharp crests, detail gathering on them) from octave MTN_FROM, where octave 2
 * marks a range. Both come from the same noise samples, so they cost nothing extra. Moons also
 * get impact craters (every other octave from 3 to 13, ~50 km down to ~20 m across on a
 * Moon-sized world), placed by an integer hash that's exact in float32 and double alike. The texture octaves
 * (i ≥ FBM_EXACT) tile every 8 lattice cells, so their offsets are wrapped into [0, 8): that keeps
 * the shader's coordinates small, and so precise to ~17 octaves (tens of metres on an Earth) where
 * the unwrapped chain lost its precision past ~11.
 *
 * Elevation (m) = A · h on airless and icy worlds, A · max(0, h − sea) where there are seas (the
 * sea surface sits at the mean radius). A = RELIEF[type] × radius; gas and ice giants have none.
 */
import { WT } from '../constants';
import { noise3dBytes, NOISE3D_SIZE } from '../lib/noise3d';
import { THREE } from '../lib/three';
import type { Body, World } from '../types';

/** Relief amplitude by world type, as a fraction of the radius. With mountain ranges h reaches
 * ~2.5 at the very highest peaks, so an Earth-sized world tops out near 12 km and a Moon-sized
 * rocky one near 6 km, under the lowest safe orbit (orbits.ts minOrbitAlt: 0.5% of the radius for
 * airless worlds). Rocky, desert, Earth-like, ocean, volcanic, icy; giants none. */
export const RELIEF = [0.0015, 0.0012, 0.0008, 0.0006, 0.0015, 0.001, 0, 0];
/** Continents: each octave's weight against the one before; mountains (terrain.glsl has the same). */
const TERR_GAIN = 0.55,
  MTN_FROM = 3,
  MTN_GAIN = 0.55,
  MTN_K = 1.3,
  MTN_MEAN = 0.3,
  FINE_FROM = 8, // from here both roughen (FINE_GAIN), so detail keeps coming as you descend
  FINE_GAIN = 0.68,
  CRATER_FROM = 3,
  CRATER_TO = 13,
  CRATER_P = 0.5;
/** Octaves the height function has at most (the shader's uTOff array size). */
export const T_OCT_MAX = 17;
/** Octaves of simplex noise before the texture takes over (noise3d.glsl FBM_EXACT). */
const FBM_EXACT = 3;
/** Octaves the physics samples: finer ones are under a metre on an Earth. */
const PHYS_OCT = 14;

const hasTerrain = (b: Body): b is World => b.kind !== 'star' && RELIEF[b.type] > 0;
/** Relief amplitude (m); 0 for stars and giants. */
export const reliefAmp = (b: Body) => (hasTerrain(b) ? RELIEF[b.type] * b.radius : 0);
/** Moons are cratered (planets' craters have long since worn away, as far as this game goes). */
export const hasCraters = (b: World) => b.kind === 'moon';
/** Whether elevation is measured from a sea (seas flatten everything below it). */
export const hasSea = (b: World) => b.type === WT.EarthLike || b.type === WT.Ocean;

/** Per-octave noise offsets O_i for a world's seed (see above); flat [x, y, z, …] for the shader. */
export function terrainOffsets(seed: number) {
  const out = new Float32Array(T_OCT_MAX * 3);
  let x = seed * 1.7,
    y = seed * 2.3,
    z = seed * 0.9;
  for (let i = 0; i < T_OCT_MAX; i++) {
    const w = (v: number) => (i >= FBM_EXACT ? ((v % 8) + 8) % 8 : v);
    out[i * 3] = w(x);
    out[i * 3 + 1] = w(y);
    out[i * 3 + 2] = w(z);
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    z = z * 2.03 + 3.1;
  }
  return out;
}

const offCache = new Map<number, Float32Array>();
const offsetsFor = (seed: number) => {
  let o = offCache.get(seed);
  if (!o) offCache.set(seed, (o = terrainOffsets(seed)));
  return o;
};

/** Raw h at a unit direction in the world's frame (the shader's terrH). `crater` gives the world's
 * radius and relief amplitude (m) if it has craters (moons). */
export function terrainH(seed: number, x: number, y: number, z: number, oct = PHYS_OCT, crater?: { R: number; A: number }) {
  const O = offsetsFor(seed);
  let a = 0.5,
    s = 0,
    k = 1.6;
  let am = 0.5,
    r = 0,
    w = 1,
    mask = 0,
    cr = 0;
  for (let i = 0; i < oct; i++) {
    const qx = x * k + O[i * 3],
      qy = y * k + O[i * 3 + 1],
      qz = z * k + O[i * 3 + 2];
    const n = i < FBM_EXACT ? snoise(qx, qy, qz) : tnoise(qx, qy, qz);
    s += a * n;
    if (i === 2) mask = smoothstep(-0.05, 0.45, n);
    if (i >= MTN_FROM) {
      let rn = 1 - Math.abs(n);
      rn *= rn;
      r += am * rn * w;
      w = Math.min(1, Math.max(0.25, rn * 1.4));
      am *= i >= FINE_FROM ? FINE_GAIN : MTN_GAIN;
    }
    if (crater && i >= CRATER_FROM && i <= CRATER_TO && (i & 1) === 1) cr += craters(qx, qy, qz, k, crater.R, crater.A);
    k *= 2.03;
    a *= i >= FINE_FROM ? FINE_GAIN : TERR_GAIN;
  }
  return s + mask * (r - MTN_MEAN) * MTN_K + cr;
}

/* Integer hashing that's exact in float32 (the shader) and double (here): values stay integers < 2^24. */
const mod289i = (x: number) => x - Math.floor((x + 0.5) * (1 / 289)) * 289;
const perm289 = (x: number) => mod289i((x * 34 + 1) * x);

/** Crater relief (h units) at lattice point q (terrain.glsl `craters` has the details). */
function craters(qx: number, qy: number, qz: number, k: number, R: number, A: number) {
  const bx = Math.floor(qx - 0.5),
    by = Math.floor(qy - 0.5),
    bz = Math.floor(qz - 0.5);
  let acc = 0;
  for (let n = 0; n < 8; n++) {
    const cx = bx + (n & 1),
      cy = by + ((n >> 1) & 1),
      cz = bz + (n >> 2);
    const h = perm289(perm289(perm289(mod289i(cz) + 7) + mod289i(cy)) + mod289i(cx));
    if (perm289(h + 5) / 289 > CRATER_P) continue;
    const ex = cx + perm289(h + 1) / 289,
      ey = cy + perm289(h + 2) / 289,
      ez = cz + perm289(h + 3) / 289;
    const r = 0.12 + (0.23 * perm289(h + 4)) / 289;
    const x = Math.hypot(qx - ex, qy - ey, qz - ez) / r;
    if (x > 1.4) continue;
    const rho = (r * R) / k;
    const depth = rho * 0.4 * Math.min(1, Math.sqrt(4000 / rho));
    const prof = (x < 1 ? Math.max(x * x - 1, -0.85) : 0) + 0.3 * Math.exp(-(((x - 1) / 0.22) ** 2));
    acc += (prof * depth) / A;
  }
  return acc;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Elevation (m) above the mean radius at a unit direction in the world's frame. */
export function elevationLocal(b: World, x: number, y: number, z: number, oct = PHYS_OCT) {
  const A = reliefAmp(b);
  if (!A) return 0;
  const h = terrainH(b.seed, x, y, z, oct, hasCraters(b) ? { R: b.radius, A } : undefined);
  return A * (hasSea(b) ? Math.max(0, h - b.pal.sea) : h);
}

const qTilt = new THREE.Quaternion(),
  qSpin = new THREE.Quaternion(),
  qW = new THREE.Quaternion(),
  AXIS_Y = new THREE.Vector3(0, 1, 0),
  tv = new THREE.Vector3(),
  tAxis = new THREE.Vector3();

/** The world's orientation (tilt, then spin about its own axis), as its mesh is drawn. */
export function worldQuat(b: World, out = new THREE.Quaternion()) {
  qTilt.setFromAxisAngle(tAxis.set(Math.cos(b.seed), 0, Math.sin(b.seed)), b.tilt);
  qSpin.setFromAxisAngle(AXIS_Y, b.rot);
  return out.copy(qTilt).multiply(qSpin);
}

/** Radius of the ground (m from the centre) under a world-space point. */
export function surfaceRadius(b: Body, pos: THREE.Vector3) {
  if (!hasTerrain(b)) return b.radius;
  tv.subVectors(pos, b.pos).normalize().applyQuaternion(worldQuat(b, qW).invert());
  return b.radius + elevationLocal(b, tv.x, tv.y, tv.z);
}

/**
 * Distance (m) from `pos` to a body's surface: the terrain under it when within a few percent of the
 * radius (where the mountains matter), the mean radius farther out.
 */
export function surfaceDist(b: Body, pos: THREE.Vector3) {
  const d = pos.distanceTo(b.pos);
  return d - (d < b.radius * 1.05 ? surfaceRadius(b, pos) : b.radius);
}

/** Height (m) above the ground under the ship (radar altitude). */
export const altitudeAt = (b: Body, pos: THREE.Vector3) => pos.distanceTo(b.pos) - surfaceRadius(b, pos);

/* ---------- noise, matching the GLSL bit for bit in structure (double precision here) ---------- */

const mod289 = (x: number) => x - Math.floor(x * (1 / 289)) * 289;
const permute = (x: number) => mod289((x * 34 + 1) * x);

/** Ashima 3D simplex noise (render/shaders/noise.glsl). */
export function snoise(vx: number, vy: number, vz: number) {
  const C1 = 1 / 6,
    C2 = 1 / 3;
  const s = (vx + vy + vz) * C2;
  let ix = Math.floor(vx + s),
    iy = Math.floor(vy + s),
    iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * C1;
  const x0 = vx - ix + t,
    y0 = vy - iy + t,
    z0 = vz - iz + t;
  // g = step(x0.yzx, x0.xyz); l = 1 − g; i1 = min(g, l.zxy); i2 = max(g, l.zxy)
  const gx = x0 >= y0 ? 1 : 0,
    gy = y0 >= z0 ? 1 : 0,
    gz = z0 >= x0 ? 1 : 0;
  const lx = 1 - gx,
    ly = 1 - gy,
    lz = 1 - gz;
  const i1x = Math.min(gx, lz),
    i1y = Math.min(gy, lx),
    i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz),
    i2y = Math.max(gy, lx),
    i2z = Math.max(gz, ly);
  const x1 = x0 - i1x + C1,
    y1 = y0 - i1y + C1,
    z1 = z0 - i1z + C1;
  const x2 = x0 - i2x + C2,
    y2 = y0 - i2y + C2,
    z2 = z0 - i2z + C2;
  const x3 = x0 - 0.5,
    y3 = y0 - 0.5,
    z3 = z0 - 0.5;
  ix = mod289(ix);
  iy = mod289(iy);
  iz = mod289(iz);
  const pz = [0, i1z, i2z, 1].map((d) => permute(iz + d));
  const py = [0, i1y, i2y, 1].map((d, n) => permute(pz[n] + iy + d));
  const p = [0, i1x, i2x, 1].map((d, n) => permute(py[n] + ix + d));
  // the shader's constant is float32: 7·n_ must round to ≥ 1 there, and does only with its rounding
  const n_ = Math.fround(0.142857142857);
  // ns = n_ * D.wyz − D.xzx with D = (0, .5, 1, 2)
  const nsx = n_ * 2 - 0,
    nsy = n_ * 0.5 - 1,
    nsz = n_ * 1 - 0;
  const X = [x0, x1, x2, x3],
    Y = [y0, y1, y2, y3],
    Z = [z0, z1, z2, z3];
  let sum = 0;
  for (let n = 0; n < 4; n++) {
    const j = p[n] - 49 * Math.floor(p[n] * nsz * nsz);
    const xq = Math.floor(j * nsz);
    const yq = Math.floor(j - 7 * xq);
    const gx2 = xq * nsx + nsy,
      gy2 = yq * nsx + nsy;
    const h = 1 - Math.abs(gx2) - Math.abs(gy2);
    const sh = h <= 0 ? -1 : 0; // -step(h, 0)
    const sx = Math.floor(gx2) * 2 + 1,
      sy = Math.floor(gy2) * 2 + 1;
    let px = gx2 + sx * sh,
      py2 = gy2 + sy * sh,
      pz2 = h;
    const inv = 1.79284291400159 - 0.85373472095314 * (px * px + py2 * py2 + pz2 * pz2);
    px *= inv;
    py2 *= inv;
    pz2 *= inv;
    let m = Math.max(0.6 - (X[n] * X[n] + Y[n] * Y[n] + Z[n] * Z[n]), 0);
    m *= m;
    sum += m * m * (px * X[n] + py2 * Y[n] + pz2 * Z[n]);
  }
  return 42 * sum;
}

/** The tiled gradient-noise texture, trilinearly filtered like the GPU does (noise3d.glsl tnoise). */
export function tnoise(x: number, y: number, z: number) {
  const d = noise3dBytes(),
    S = NOISE3D_SIZE;
  // texture coordinate p/8, in texels, from texel centres
  const fx = x * 0.125 * S - 0.5,
    fy = y * 0.125 * S - 0.5,
    fz = z * 0.125 * S - 0.5;
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    z0 = Math.floor(fz);
  const u = fx - x0,
    v = fy - y0,
    w = fz - z0;
  const wr = (i: number) => ((i % S) + S) % S;
  const at = (i: number, j: number, k: number) => d[wr(i) + S * (wr(j) + S * wr(k))];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), u),
    c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), u),
    c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), u),
    c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), u);
  const c = lerp(lerp(c00, c10, v), lerp(c01, c11, v), w);
  return (c / 255) * 2 - 1;
}
