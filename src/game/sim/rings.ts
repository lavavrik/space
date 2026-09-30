/*
 * Planetary rings as belts of rock (docs/rings.md). From afar a ring is a textured disc
 * (render/shaders/ring.frag.glsl); up close it's the rocks themselves (render/RingField.ts). Both
 * read the same density: bands from two octaves of noise across the radius, soft edges, and a
 * Cassini-like division at 63 % of the way out.
 *
 * The rocks are generated, not stored: the ring is cut into cells in its own co-orbiting frame, and
 * each cell's rocks come from a hash of its indices (on the GPU: render/RingField.ts). A radial bin
 * turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks
 * overtake outer ones, and a ship on the same orbit sees its neighbours drift slowly.
 */
import type { World } from '../types';
import { snoise } from './terrain';

/** The ring's half-thickness (m): real rings are tens of metres thick; this one reads as a belt. */
export const RING_HALF_THICK = 1500;

/**
 * Density of the ring at `rR` (in planet radii), 0…~0.85: the disc's opacity, and (divided by its
 * peak) how full the rock cells are. Mirrors ring.frag.glsl.
 */
export function ringDensity(b: World, rR: number) {
  const ring = b.ring;
  if (!ring) return 0;
  const t = (rR - ring.inner) / (ring.outer - ring.inner);
  if (t <= 0 || t >= 1) return 0;
  const band = 0.55 + 0.35 * snoise(rR * 14, ring.seed, 0) + 0.25 * snoise(rR * 60, ring.seed, 1);
  const ss = (a: number, c: number, x: number) => {
    const u = Math.min(1, Math.max(0, (x - a) / (c - a)));
    return u * u * (3 - 2 * u);
  };
  return ss(0, 0.06, t) * ss(1, 0.86, t) * Math.min(1, Math.max(0, band)) * 0.85 * ss(0.015, 0.04, Math.abs(t - 0.63));
}

/**
 * The ring's rocks, all generated on the GPU (render/RingField.ts). Each layer is a grid of
 * `grid` × `grid` cells centred on the camera (cell = 2 · range / grid), `perCell` candidate
 * rocks each, spread through the belt's thickness; a rock exists where a hash of its cell falls under
 * the ring's density. `detail` ≥ 0: drawn as a lumpy mesh (icosphere subdivision); −1: as a speck.
 * Each layer fades in from `inner` to `fadeTo` and out over the last 15–50 % of its range.
 *
 * Sizes are rock radii (m). The first speck layer carries on the boulders' own population (same
 * sizes, the same number per area) as they shrink away, so there's no step where meshes turn to
 * specks; beyond it the disc's band takes over, with a sparse grain of far specks on it.
 */
export interface RockLayer {
  /**
   * Closer in, the same rocks drawn with finer meshes: each level's subdivision out to its `cut`
   * (m), nearest first; `detail` is the mesh beyond the last cut.
   */
  lods?: { detail: number; cut: number }[];
  grid: number;
  range: number;
  perCell: number;
  minR: number;
  maxR: number;
  detail: number;
  inner: number;
  fadeTo: number;
}
export const ROCK_LAYERS: RockLayer[] = [
  // (the meshes' ranges were half these, on grids of 128: the same cells, so the same rocks, now twice
  // as far out)
  { grid: 256, range: 6e3, perCell: 3, minR: 1.5, maxR: 10, detail: 0, inner: 0, fadeTo: 0, lods: [{ detail: 3, cut: 500 }] }, // pebbles
  { grid: 256, range: 50e3, perCell: 3, minR: 10, maxR: 70, detail: 0, inner: 0, fadeTo: 0, lods: [{ detail: 3, cut: 4000 }] }, // rocks
  { grid: 256, range: 300e3, perCell: 4, minR: 70, maxR: 500, detail: 0, inner: 0, fadeTo: 0, lods: [{ detail: 3, cut: 10000 }, { detail: 1, cut: 40000 }] }, // boulders
  // the boulders as specks: 4 per (2.34 km)² → 16 per (4.7 km)², fading in as they shrink away
  { grid: 256, range: 600e3, perCell: 16, minR: 70, maxR: 500, detail: -1, inner: 150e3, fadeTo: 300e3 },
  // sparse grain on the disc far off
  { grid: 256, range: 12000e3, perCell: 14, minR: 60, maxR: 400, detail: -1, inner: 500e3, fadeTo: 650e3 },
];
/** Where the disc's band takes over from the specks (m): the boulder specks' range, less their fade. */
export const DISC_FROM = 540e3;
