/*
 * Where people live on a populated world: mirrors cityPop in render/shaders/cityLights.glsl (keep
 * the two in step), so the sim can put things where the city lights are (sky stations over them).
 */
import { WT } from '../constants';
import type { World } from '../types';
import { snoise, terrainH } from './terrain';

/** Is this world populated (city lights at night)? */
export const populated = (b: World) => b.type === WT.EarthLike;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Population density 0…1 at unit direction (x, y, z) in the world's own frame; 0 at sea. */
export function population(b: World, x: number, y: number, z: number) {
  const e = terrainH(b.seed, x, y, z) - b.pal.sea; // above sea level, in terrain h units
  if (e <= 0.002) return 0;
  const land = smoothstep(0.002, 0.01, e) * smoothstep(0.42, 0.18, e);
  const coast = 1 + 1.6 * smoothstep(0.08, 0, e);
  const temperate = smoothstep(0.82, 0.55, Math.abs(y));
  const s = b.seed;
  const region = smoothstep(-0.25, 0.45, snoise(x * 2.3 + s * 3.1, y * 2.3 + 11, z * 2.3 + s));
  const rural = 0.55 + 0.45 * smoothstep(-0.3, 0.6, snoise(x * 9 + 5, y * 9 + s, z * 9 + 2));
  return Math.min(1, Math.max(0, land * coast * temperate * region * rural));
}
