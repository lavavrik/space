/*
 * The shape of a depot (docs/lagrange.md), the station parked at a Lagrange point, in its own frame,
 * in units of its spine's length S. Local +z is up out of the landing plate and +x runs along the
 * spine; it keeps one attitude in space and doesn't spin (no gravity: a ship is held on its pad by
 * the docking code, like on the sky deck).
 *
 *   - The landing plate: a round open deck, DISC_R across, its top at z = 0, at the spine's +x end.
 *     Its 8 pads ring it, open to space.
 *   - The spine: a square truss along x under the plate and out the other way.
 *   - The tank farm at the −x end: two rings of four propellant spheres round the spine.
 *   - Under the plate, the habitat block; hanging off the spine, two radiator fins.
 *   - Two solar wings, flat on either side of the spine amidships.
 *   - A beacon mast at the −x end.
 *
 * Pure geometry, like sim/stationGeom.ts and sim/skyGeom.ts; docking.ts and autodock.ts treat it as
 * an open deck (`isDeck`); the mesh is render/depotMesh.ts, the same shapes.
 */
import { THREE } from '../lib/three';
import type { Where } from './stationGeom';

/** The landing plate: centre (x), radius and thickness. Its top is z = 0. */
export const PLATE_X = 0.3,
  PLATE_R = 0.19,
  PLATE_T = 0.014;
/** The spine truss: x ∈ [SPINE_X0, SPINE_X1], |y| < SPINE_HW, z from SPINE_Z0 to SPINE_Z1. */
export const SPINE_X0 = -0.5,
  SPINE_X1 = 0.34,
  SPINE_HW = 0.022,
  SPINE_Z0 = -0.085,
  SPINE_Z1 = -0.04;
/** The spine's axis height (the tanks ring it). */
export const SPINE_ZC = (SPINE_Z0 + SPINE_Z1) / 2;
/** Tank rings: x, sphere radius and how far the sphere centres sit off the spine axis. */
export const TANK_RINGS = [
  { x: -0.43, r: 0.058, off: 0.075 },
  { x: -0.29, r: 0.046, off: 0.066 },
] as const;
/** The tanks in one ring sit at the four compass points round the spine. */
export const TANK_DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;
/** The habitat block under the plate. */
export const HAB = { x0: 0.2, x1: 0.4, hw: 0.05, z0: -0.13, z1: SPINE_Z1 };
/** Radiator fins: thin panels hanging under the spine, at y = ±FIN_Y. */
export const FIN = { x0: -0.02, x1: 0.14, y: 0.05, t: 0.004, z0: -0.2, z1: SPINE_Z0 };
/** Solar wings: flat panels either side of the spine, out to WING_Y. */
export const WING = { x0: -0.2, x1: -0.04, y0: 0.06, y1: 0.34, t: 0.004, z: SPINE_ZC };
/** The beacon mast at the tank end. */
export const MAST = { x: -0.5, r: 0.004, z1: 0.13 };

/** Pads: 8 round the plate (sim/stationGeom.ts PAD_R is their radius). */
export const DEPOT_PAD_COUNT = 8;
export const PAD_RING = 0.115;

/** Pad `i` (0-based): its centre on the plate, its "up", and which way a ship on it faces (outward). */
export function depotPadLocal(i: number) {
  const phi = (i / DEPOT_PAD_COUNT) * Math.PI * 2 + Math.PI / DEPOT_PAD_COUNT;
  const c = Math.cos(phi),
    s = Math.sin(phi);
  return { pos: new THREE.Vector3(PLATE_X + PAD_RING * c, PAD_RING * s, 0), up: new THREE.Vector3(0, 0, 1), fwd: new THREE.Vector3(c, s, 0), phi };
}

const nearBox = (p: THREE.Vector3, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: number) =>
  p.x > x0 - m && p.x < x1 + m && p.y > y0 - m && p.y < y1 + m && p.z > z0 - m && p.z < z1 + m;

/** Centre of tank `i` (0–7: ring, then compass point), in unit coordinates. */
export function tankAt(i: number) {
  const ring = TANK_RINGS[i >> 2];
  const d = TANK_DIRS[i & 3];
  return { c: new THREE.Vector3(ring.x, d[0] * ring.off, SPINE_ZC + d[1] * ring.off), r: ring.r };
}

/**
 * Classify a point (unit coordinates) with a clearance `m`: 'wall' if it's within `m` of the
 * structure, else 'outside'. It's all open, so there's no inside.
 */
export function depotWhereIs(p: THREE.Vector3, m: number): Where {
  if (p.x < SPINE_X0 - m || p.x > PLATE_X + PLATE_R + m || Math.abs(p.y) > WING.y1 + m || p.z > MAST.z1 + m || p.z < FIN.z0 - m) return 'outside';
  // the plate
  if (p.z > -PLATE_T - m && p.z < m && Math.hypot(p.x - PLATE_X, p.y) < PLATE_R + m) return 'wall';
  if (nearBox(p, SPINE_X0, SPINE_X1, -SPINE_HW, SPINE_HW, SPINE_Z0, SPINE_Z1, m)) return 'wall';
  if (nearBox(p, HAB.x0, HAB.x1, -HAB.hw, HAB.hw, HAB.z0, HAB.z1, m)) return 'wall';
  for (const s of [-1, 1]) {
    if (nearBox(p, FIN.x0, FIN.x1, s * FIN.y - FIN.t, s * FIN.y + FIN.t, FIN.z0, FIN.z1, m)) return 'wall';
    if (nearBox(p, WING.x0, WING.x1, s > 0 ? WING.y0 : -WING.y1, s > 0 ? WING.y1 : -WING.y0, WING.z - WING.t, WING.z + WING.t, m)) return 'wall';
  }
  if (p.x > MAST.x - MAST.r - m && p.x < MAST.x + MAST.r + m && Math.abs(p.y) < MAST.r + m && p.z > SPINE_Z1 - m && p.z < MAST.z1 + m) return 'wall';
  if (p.x > TANK_RINGS[0].x - TANK_RINGS[0].r - m && p.x < TANK_RINGS[1].x + TANK_RINGS[1].r + m)
    for (let i = 0; i < 8; i++) {
      const t = tankAt(i);
      if (p.distanceTo(t.c) < t.r + m) return 'wall';
    }
  return 'outside';
}

/** Is a point (unit coordinates) over the plate (within `m` of its outline, seen from above)? */
export const overPlate = (p: THREE.Vector3, m = 0) => Math.hypot(p.x - PLATE_X, p.y) < PLATE_R + m;
