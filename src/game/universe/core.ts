import { ARRIVE_FLUX, AU, C, CORE_DIR, CORE_DIST, CORE_MASS, GRAV, MSUN, RSUN, SECTOR_SIZE } from '../constants';
import { kelvin } from '../lib/color';
import { THREE } from '../lib/three';
import type { StarInfo, StarSystem } from '../types';

/*
 * The galactic core (docs/blackhole.md): a supermassive black hole at a fixed point CORE_DIST ly from
 * home, toward the Milky Way's brightest stretch. It's index 0 of its sector (galaxy.ts puts it there,
 * as it does home in 0,0,0), so its id, saves and the nav list need nothing special.
 *
 * 1e8 M☉ rather than Sgr A*'s 4.3e6: where a black hole's shadow looks a given size, its pull goes as
 * 1/M, and at Sgr A*'s mass it's ~900 m/s² there, past the ship's thrust. At 1e8 it's ~26 m/s².
 */

export const CORE_NAME = 'Galactic Core';
export const CORE_POS = new THREE.Vector3(...CORE_DIR).normalize().multiplyScalar(CORE_DIST);
/** Its sector (sector i spans [(i − ½)·S, (i + ½)·S) on each axis). */
export const CORE_SECTOR = CORE_POS.toArray().map((x) => Math.round(x / SECTOR_SIZE)) as [number, number, number];
export const CORE_ID = `${CORE_SECTOR.join(',')}:0`;

/** Schwarzschild radius, the event horizon (m): 2GM/c². */
export const CORE_RS = (2 * GRAV * CORE_MASS * MSUN) / (C * C);
/** The accretion disk, in m: from the innermost stable orbit (3 Rs) out to 30 Rs. */
export const DISK_IN = 3 * CORE_RS;
export const DISK_OUT = 30 * CORE_RS;
/** You arrive this far out (m): the shadow ~4° across, the disk ~40°. */
export const CORE_ARRIVE = 150 * AU;
/** The disk's luminosity (L☉): ARRIVE_FLUX at CORE_ARRIVE, so arrival, lighting and heat work as at a star. */
export const DISK_L = ARRIVE_FLUX * (CORE_ARRIVE / AU) ** 2;
/** The disk's overall colour, as a light. */
const DISK_T = 5500;

let cache: StarSystem | null = null;
/** The core as a galaxy record. */
export function coreSystem(): StarSystem {
  return (cache ??= {
    id: CORE_ID,
    seed: 0x0c0e,
    pos: CORE_POS.clone(),
    name: CORE_NAME,
    star: { cls: 'BH', spec: 'Black hole', T: DISK_T, R: CORE_RS / RSUN, L: DISK_L, color: kelvin(DISK_T), hole: true } satisfies StarInfo,
  });
}
