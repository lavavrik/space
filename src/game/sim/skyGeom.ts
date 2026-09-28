/*
 * The shape of a sky station (docs/docking.md), in its own frame, in units of its deck's diameter S.
 * Local +z is straight up (away from its world's centre); x and y lie in the deck's plane.
 *
 *   - The deck: a disc of radius DECK_R, its flat top at z = 0 and DECK_T thick. The pads are on
 *     top, open to the sky: SKY_OUTER round the rim and SKY_INNER closer in. There's no hangar;
 *     "down" is simply down, the world's gravity.
 *   - The control tower in the middle, with a wider cab on top.
 *   - Under the deck, a tapering keel and four lift-fan pods round the rim that hold it up.
 *
 * Pure geometry, like sim/stationGeom.ts (the orbital cube); docking.ts and autodock.ts branch on
 * `st.sky`; the mesh is render/skyMesh.ts, the same shapes.
 */
import { THREE } from '../lib/three';
import type { Where } from './stationGeom';

export const DECK_R = 0.5,
  DECK_T = 0.03;
export const TOWER_R = 0.05,
  CAB_R = 0.075,
  CAB_Z0 = 0.1,
  CAB_Z1 = 0.14;
/** The keel: a cone from KEEL_R0 under the deck down to KEEL_R1 at KEEL_Z. */
export const KEEL_R0 = 0.4,
  KEEL_R1 = 0.1,
  KEEL_Z = -0.24;
/** Lift-fan pods: POD_N of them at radius POD_AT, POD_R across, hanging to POD_Z. */
export const POD_N = 4,
  POD_AT = 0.45,
  POD_R = 0.05,
  POD_Z = -0.12;

/** Pads: SKY_OUTER evenly round a circle at OUTER_AT, SKY_INNER at INNER_AT between them. */
const SKY_OUTER = 8,
  OUTER_AT = 0.36,
  SKY_INNER = 4,
  INNER_AT = 0.19;
export const SKY_PAD_COUNT = SKY_OUTER + SKY_INNER;

/** Pad `i` (0-based): its centre on the deck, its "up", and which way a ship on it faces (outward). */
export function skyPadLocal(i: number) {
  const outer = i < SKY_OUTER;
  const phi = outer ? (i / SKY_OUTER) * Math.PI * 2 : ((i - SKY_OUTER + 0.5) / SKY_INNER) * Math.PI * 2;
  const r = outer ? OUTER_AT : INNER_AT;
  const c = Math.cos(phi),
    s = Math.sin(phi);
  return { pos: new THREE.Vector3(r * c, r * s, 0), up: new THREE.Vector3(0, 0, 1), fwd: new THREE.Vector3(c, s, 0), phi };
}

/** Pod `k`'s centre in the deck's plane. */
export const podAt = (k: number) => {
  const phi = ((k + 0.5) / POD_N) * Math.PI * 2;
  return [POD_AT * Math.cos(phi), POD_AT * Math.sin(phi)] as const;
};

/**
 * Classify a point (unit coordinates) with a clearance `m`: 'wall' if it's within `m` of the
 * structure, else 'outside'. Everything's open, so there's no inside.
 */
export function skyWhereIs(p: THREE.Vector3, m: number): Where {
  const r = Math.hypot(p.x, p.y);
  if (r > DECK_R + m || p.z > CAB_Z1 + m || p.z < KEEL_Z - m) return 'outside';
  // deck
  if (p.z < m && p.z > -DECK_T - m) return 'wall';
  // tower and its cab
  if (p.z >= 0 && r < (p.z > CAB_Z0 - m ? CAB_R : TOWER_R) + m) return 'wall';
  if (p.z < -DECK_T) {
    // keel: its radius at this height, plus the clearance
    const u = (p.z - -DECK_T) / (KEEL_Z - -DECK_T);
    if (r < KEEL_R0 + (KEEL_R1 - KEEL_R0) * Math.min(1, Math.max(0, u)) + m) return 'wall';
    if (p.z > POD_Z - m)
      for (let k = 0; k < POD_N; k++) {
        const [x, y] = podAt(k);
        if (Math.hypot(p.x - x, p.y - y) < POD_R + m) return 'wall';
      }
  }
  return 'outside';
}
