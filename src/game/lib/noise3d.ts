import { mulberry32 } from './rng';
import { THREE } from './three';

/**
 * A tileable 3D gradient-noise texture (64³ texels, 8 lattice cells per axis) for the fine octaves
 * of the planet shaders. One trilinear texture read replaces a simplex-noise evaluation (a few
 * dozen ALU ops and permutation hashes), which is what made a planet filling a 4K screen slow.
 * The coarse octaves stay exact simplex noise, so continents and cloud patterns don't change.
 *
 * Stored as noise / (4σ) in 8 bits, so the shader decodes it to unit σ-scaled noise (see
 * noise3d.glsl). Deterministic: the same texture every run.
 */
export const NOISE3D_SIZE = 64,
  NOISE3D_CELLS = 8;

/** The texture's bytes (also sampled on the CPU by sim/terrain.ts, so collisions match the GPU). */
export function noise3dData(size = NOISE3D_SIZE, cells = NOISE3D_CELLS) {
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
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const vals = new Float32Array(size ** 3);
  let sum = 0,
    sum2 = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = x / S,
          fy = y / S,
          fz = z / S;
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
        vals[x + size * (y + size * z)] = n;
        sum += n;
        sum2 += n * n;
      }
  const sd = Math.sqrt(sum2 / vals.length - (sum / vals.length) ** 2);
  const data = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) data[i] = Math.max(0, Math.min(255, Math.round((vals[i] / (4 * sd)) * 127.5 + 127.5)));
  return data;
}

let cached: Uint8Array | null = null;
/** noise3dData(), built once. */
export const noise3dBytes = () => (cached ??= noise3dData());

export function createNoiseTexture() {
  const size = NOISE3D_SIZE;
  const data = noise3dBytes().slice();
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
