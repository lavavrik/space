import { GALAXY_SEED, SECTOR_SIZE, STAR_DENSITY } from '../constants';
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import type { StarSystem } from '../types';
import { makeName, starName } from './names';
import { makeStar } from './stars';
import { buildSystem, findHome } from './system';

/*
 * The galaxy is an unbounded local cluster that never exists as a whole. Space is cut into cubic
 * sectors SECTOR_SIZE ly on a side, and a sector's stars are a pure function of the galaxy seed and
 * its integer coordinates. Only the sectors around the ship are generated (and cached), so every
 * star is just a cheap record (position, seed, star type) until you jump there and `buildSystem`
 * creates its planets.
 *
 * Sector (ix, iy, iz) covers [(i − ½)·S, (i + ½)·S) on each axis, so sector 0,0,0 is centred on
 * home at the origin.
 */

/** Mean systems per sector (≈ 1.5). */
const PER_SECTOR = STAR_DENSITY * SECTOR_SIZE ** 3;
const MAX_CACHED = 40000; // sectors; a full sky query touches about 9,300 (≈ 6,400 stars)

export const HOME_ID = '0,0,0:0';

/** Integer hash of the galaxy seed and a few integers (murmur3-style mixing), as a uint32. */
export function hash32(...ns: number[]) {
  let h = GALAXY_SEED | 0;
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0xcc9e2d51);
    h = (h << 15) | (h >>> 17);
    h = Math.imul(h, 0x1b873593) ^ 0x9e3779b9;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The home system, generated exactly as in the original fixed galaxy so it keeps its name (Venydes)
 * and planets: a Sun-like star whose seed is nudged until it holds an Earth-like world with a moon.
 */
function makeHome(): StarSystem {
  const g = mulberry32(GALAXY_SEED);
  const seed = Math.floor(g() * 1e9);
  const sr = mulberry32(seed);
  const name = makeName(sr, new Set()),
    star = makeStar(sr, true);
  const sys: StarSystem = { id: HOME_ID, seed, pos: new THREE.Vector3(), name, star };
  for (let k = 0; k < 400; k++) {
    if (findHome(buildSystem(sys))) break;
    sys.seed = seed + k + 1;
  }
  return sys;
}

/**
 * Generate one sector's systems (uncached). The count is ⌊PER_SECTOR⌋ or one more, which keeps the
 * number of stars within jump range steady (about 100 ± 15) while positions stay random.
 */
export function generateSector(ix: number, iy: number, iz: number): StarSystem[] {
  const g = mulberry32(hash32(ix, iy, iz));
  const n = Math.floor(PER_SECTOR) + (g() < PER_SECTOR % 1 ? 1 : 0);
  const out: StarSystem[] = [];
  const S = SECTOR_SIZE;
  for (let k = 0; k < n; k++) {
    const pos = new THREE.Vector3((ix - 0.5 + g()) * S, (iy - 0.5 + g()) * S, (iz - 0.5 + g()) * S);
    if (k === 0 && ix === 0 && iy === 0 && iz === 0) {
      out.push(homeSystem());
      continue;
    }
    const seed = hash32(ix, iy, iz, k + 1);
    const sr = mulberry32(seed);
    out.push({ id: `${ix},${iy},${iz}:${k}`, seed, pos, name: starName(sr), star: makeStar(sr, false) });
  }
  return out;
}

let homeCache: StarSystem | null = null;
/** The starting system, at the galactic origin. */
export function homeSystem() {
  return (homeCache ??= makeHome());
}

const sectors = new Map<string, StarSystem[]>();

function sector(ix: number, iy: number, iz: number) {
  const key = `${ix},${iy},${iz}`;
  let s = sectors.get(key);
  if (!s) {
    if (sectors.size >= MAX_CACHED) sectors.clear();
    s = generateSector(ix, iy, iz);
    sectors.set(key, s);
  }
  return s;
}

/** Every system within `radius` ly of `center` (galactic frame, ly), in no particular order. */
export function systemsNear(center: THREE.Vector3, radius: number): StarSystem[] {
  const S = SECTOR_SIZE,
    r2 = radius * radius;
  const lo = (c: number) => Math.floor((c - radius) / S + 0.5),
    hi = (c: number) => Math.floor((c + radius) / S + 0.5);
  const out: StarSystem[] = [];
  for (let ix = lo(center.x); ix <= hi(center.x); ix++)
    for (let iy = lo(center.y); iy <= hi(center.y); iy++)
      for (let iz = lo(center.z); iz <= hi(center.z); iz++)
        for (const s of sector(ix, iy, iz)) if (s.pos.distanceToSquared(center) <= r2) out.push(s);
  return out;
}

/** The system with this id ("ix,iy,iz:k": the k-th of its sector), or null if there's none. */
export function systemById(id: string): StarSystem | null {
  if (id === HOME_ID) return homeSystem();
  const m = /^(-?\d+),(-?\d+),(-?\d+):(\d+)$/.exec(id);
  if (!m) return null;
  return sector(+m[1], +m[2], +m[3]).find((s) => s.id === id) ?? null;
}
