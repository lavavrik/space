/**
 * A world's cloud cover on the CPU: the same function the GPU bakes into its cloud cube
 * (gpu/shaders/clouds.wgsl cloudRaw, cloudCover), for finding where the weather is (the debug
 * jumps, debug/poses.ts). Coarse: the bake's 7 octaves, before the volumetric clouds' own finer
 * break-up (vclouds.wgsl).
 */
import { WT } from '../constants';
import { THREE } from '../lib/three';
import type { World } from '../types';
import { snoise, tnoise, worldQuat } from './terrain';

/** Octaves of simplex noise before the texture takes over (noise3d.wgsl FBM_EXACT). */
const FBM_EXACT = 3;

function fbm(x: number, y: number, z: number, oct: number) {
  let a = 0.5,
    s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * (i < FBM_EXACT ? snoise(x, y, z) : tnoise(x, y, z));
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    z = z * 2.03 + 3.1;
    a *= 0.5;
  }
  return s;
}

/** clouds.wgsl cloudRaw at a unit direction in the world's own frame. */
export function cloudRaw(seed: number, x: number, y: number, z: number, oct = 7) {
  const cx = (x * 1.6 + seed * 1.7) * 1.25,
    cy = (y * 1.6 + seed * 2.3) * 1.25,
    cz = (z * 1.6 + seed * 0.9) * 1.25;
  const w = fbm(cx * 2, cy * 2, cz * 2, 4) * 0.7;
  return fbm(cx + w, cy + w, cz + w, oct);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** clouds.wgsl cloudCover: 0…1. */
export function cloudCoverOf(b: World, raw: number) {
  const wet = b.type === WT.EarthLike || b.type === WT.Ocean;
  return smooth(wet ? -0.2 : 0.02, wet ? 0.25 : 0.5, raw) * (b.type === WT.Ocean ? 0.95 : 0.85);
}

const q = new THREE.Quaternion(),
  v = new THREE.Vector3();

/** The cover over the point of `b` in the direction `dir` (world space, from its centre). */
export function cloudCoverAt(b: World, dir: THREE.Vector3) {
  v.copy(dir).normalize().applyQuaternion(worldQuat(b, q).invert());
  return cloudCoverOf(b, cloudRaw(b.seed, v.x, v.y, v.z));
}
