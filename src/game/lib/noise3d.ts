import { mulberry32 } from './rng';

/**
 * A tileable 3D gradient-noise texture (64³ texels, 8 lattice cells per axis) for the fine octaves
 * of the planet shaders. One trilinear texture read replaces a simplex-noise evaluation (a few
 * dozen ALU ops and permutation hashes), which is what made a planet filling a 4K screen slow.
 * The coarse octaves stay exact simplex noise, so continents and cloud patterns don't change.
 *
 * Stored as noise / (4σ) in 8 bits, so the shader decodes it to unit σ-scaled noise (see
 * gpu/shaders/noise3d.wgsl). Deterministic: the same texture every run.
 */
export const NOISE3D_SIZE = 64,
  NOISE3D_CELLS = 8;

/** The lattice's gradients (unit vectors), the texture's noise at each texel, and its spread. */
function noise3dSource(size = NOISE3D_SIZE, cells = NOISE3D_CELLS) {
  const S = size / cells;
  const rnd = mulberry32(0x5eed3d);
  const grads: number[][] = [];
  for (let i = 0; i < cells ** 3; i++) {
    let x, y, z, l;
    do {
      x = rnd() * 2 - 1;
      y = rnd() * 2 - 1;
      z = rnd() * 2 - 1;
      l = x * x + y * y + z * z;
    } while (l > 1 || l < 1e-4);
    l = Math.sqrt(l);
    grads.push([x / l, y / l, z / l]);
  }
  const wrap = (i: number) => ((i % cells) + cells) % cells;
  const grad = (i: number, j: number, k: number) => grads[wrap(i) + cells * (wrap(j) + cells * wrap(k))];
  const vals = new Float32Array(size ** 3);
  let sum = 0,
    sum2 = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const n = perlin(grad, x / S, y / S, z / S);
        vals[x + size * (y + size * z)] = n;
        sum += n;
        sum2 += n * n;
      }
  const sd = Math.sqrt(sum2 / vals.length - (sum / vals.length) ** 2);
  return { grads, vals, sd, grad };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** Gradient noise at lattice coordinates (fx, fy, fz) from the lattice's gradients. */
function perlin(grad: (i: number, j: number, k: number) => number[], fx: number, fy: number, fz: number) {
  const i0 = Math.floor(fx),
    j0 = Math.floor(fy),
    k0 = Math.floor(fz);
  const u = fx - i0,
    v = fy - j0,
    w = fz - k0;
  let n = 0;
  for (let dk = 0; dk < 2; dk++)
    for (let dj = 0; dj < 2; dj++)
      for (let di = 0; di < 2; di++) {
        const gr = grad(i0 + di, j0 + dj, k0 + dk);
        const d = gr[0] * (u - di) + gr[1] * (v - dj) + gr[2] * (w - dk);
        n += d * (di ? fade(u) : 1 - fade(u)) * (dj ? fade(v) : 1 - fade(v)) * (dk ? fade(w) : 1 - fade(w));
      }
  return n;
}

/** The texture's bytes (also sampled on the CPU by sim/terrain.ts, so collisions match the GPU). */
export function noise3dData(size = NOISE3D_SIZE, cells = NOISE3D_CELLS) {
  const { vals, sd } = noise3dSource(size, cells);
  const data = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) data[i] = Math.max(0, Math.min(255, Math.round((vals[i] / (4 * sd)) * 127.5 + 127.5)));
  return data;
}

let src: ReturnType<typeof noise3dSource> | null = null;
const source = () => (src ??= noise3dSource());

/**
 * The lattice's gradients ÷ 4σ, as rgba32 (w unused), x fastest: the noise the texture holds,
 * worked out exactly (gpu/shaders/noise3d.wgsl gnoise; sim/terrain.ts).
 */
export function noise3dGrads() {
  const { grads, sd } = source();
  const out = new Float32Array(grads.length * 4);
  grads.forEach((g, i) => out.set([g[0] / (4 * sd), g[1] / (4 * sd), g[2] / (4 * sd), 0], i * 4));
  return out;
}

/**
 * The texture's noise exactly, smooth (C2: quintic fade), at the texture's own coordinates (as
 * tnoise(p): p in lattice cells, the texture's half-texel offset included). Linearly interpolated
 * between texels, its slope jumped at every texel's face: straight lines across the terrain.
 */
export function gnoise(x: number, y: number, z: number) {
  const { grad, sd } = source();
  return perlin(grad, x - 0.0625, y - 0.0625, z - 0.0625) / (4 * sd);
}

let cached: Uint8Array | null = null;
/** noise3dData(), built once. */
export const noise3dBytes = () => (cached ??= noise3dData());
