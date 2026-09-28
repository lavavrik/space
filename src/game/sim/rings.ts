/*
 * Planetary rings as belts of rock (docs/rings.md). From afar a ring is a textured disc
 * (render/shaders/ring.frag.glsl); up close it's the rocks themselves (render/RingField.ts). Both
 * read the same density: bands from two octaves of noise across the radius, soft edges, and a
 * Cassini-like division at 63 % of the way out.
 *
 * The rocks are generated, not stored: the ring is cut into cells in its own co-orbiting frame
 * (radial bins of CELL width; in each, angular bins about CELL long along the orbit; and vertical
 * bins through the ring's thickness), and each cell's rocks come from a hash of its indices. A radial
 * bin turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks
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
 * Rock size tiers: rock radius range (m), cell size (m), how far out they're drawn (m), rocks per
 * full cell, and how they're drawn: an icosphere of this subdivision (0 to 2), or −1 for a point.
 * The points go from where the boulders stop to far out, so the disc's grey band only starts where
 * even a 800 m rock is under a pixel.
 */
export interface RockTier {
  minR: number;
  maxR: number;
  cell: number;
  range: number;
  perCell: number;
  detail: number;
}
export const ROCK_TIERS: RockTier[] = [
  { minR: 1.5, maxR: 10, cell: 250, range: 2500, perCell: 1.2, detail: 0 },
  { minR: 10, maxR: 70, cell: 1000, range: 12000, perCell: 1.6, detail: 1 },
  { minR: 70, maxR: 500, cell: 5000, range: 60000, perCell: 1.6, detail: 2 },
  { minR: 100, maxR: 800, cell: 12000, range: 250000, perCell: 25, detail: -1 },
];

/** Integer hash (murmur-style) of a few integers, as a uint32. */
export function hashInts(...ns: number[]) {
  let h = 0x2545f491;
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0xcc9e2d51);
    h = (h << 15) | (h >>> 17);
    h = Math.imul(h, 0x1b873593) ^ 0x9e3779b9;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h ^ (h >>> 16)) >>> 0;
}
