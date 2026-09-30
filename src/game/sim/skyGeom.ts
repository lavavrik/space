/*
 * The shape of a sky station (docs/docking.md), in its own frame, in units of its deck's length S:
 * a flying aircraft carrier. Local +z is straight up (away from its world's centre); x runs along
 * the deck (the bow at +x), y across it.
 *
 *   - The flight deck: a rectangle DECK_L long and DECK_W wide (5 : 1), its flat top at z = 0 and
 *     DECK_T thick. The pads are on top, open to the sky: two rows along it. There's no hangar;
 *     "down" is simply down, the world's gravity.
 *   - The island: the control tower on the starboard (+y) edge amidships, with its bridge (lit
 *     windows) on top and a beacon mast.
 *   - Under the deck, the hull (a narrower box), and lift-fan pods along both sides under the
 *     deck's overhang that hold it up.
 *
 * (It was a round deck with a tower in the middle and a conical keel.)
 *
 * Pure geometry, like sim/stationGeom.ts (the orbital cube); docking.ts and autodock.ts branch on
 * `st.sky`; the mesh is render/skyMesh.ts, the same shapes.
 */
import { THREE } from '../lib/three';
import type { Where } from './stationGeom';

export const DECK_L = 1,
  DECK_W = 0.2,
  DECK_T = 0.02;
/** The hull under the deck: a box x ∈ [HULL_X0, HULL_X1], |y| < HULL_HW, down to HULL_Z. */
export const HULL_X0 = -0.46,
  HULL_X1 = 0.44,
  HULL_HW = 0.07,
  HULL_Z = -0.09;
/** The island: a box on the starboard edge; its bridge is the top BRIDGE_H of it. */
export const ISL_X0 = -0.07,
  ISL_X1 = 0.07,
  ISL_Y0 = 0.062,
  ISL_Y1 = 0.095,
  ISL_Z = 0.075,
  BRIDGE_H = 0.018;
/** Lift-fan pods: POD_N a side, POD_R across, under the deck's overhang, hanging to POD_Z. */
export const POD_N = 3,
  POD_Y = 0.085,
  POD_R = 0.022,
  POD_Z = -0.06;

/** Pads: two rows along the deck (the starboard row leaves the island clear). */
const ROW_A = { y: -0.054, x: [-0.42, -0.28, -0.14, 0.0, 0.14, 0.28] },
  ROW_B = { y: 0.037, x: [-0.42, -0.28, -0.14, 0.16, 0.3, 0.42] };
export const SKY_PAD_COUNT = ROW_A.x.length + ROW_B.x.length;

/** Pad `i` (0-based): its centre on the deck, its "up", and which way a ship on it faces (the bow). */
export function skyPadLocal(i: number) {
  const a = i < ROW_A.x.length;
  const row = a ? ROW_A : ROW_B;
  const x = row.x[a ? i : i - ROW_A.x.length];
  return { pos: new THREE.Vector3(x, row.y, 0), up: new THREE.Vector3(0, 0, 1), fwd: new THREE.Vector3(1, 0, 0), phi: 0 };
}

/** Pod `k`'s centre in the deck's plane (port side first). */
export const podAt = (k: number) => {
  const side = k < POD_N ? -1 : 1;
  const j = k % POD_N;
  return [-0.33 + (0.66 * j) / (POD_N - 1), side * POD_Y] as const;
};

/** Is (x, y, z) within `m` of the box [x0, x1] × [y0, y1] × [z0, z1]? */
const nearBox = (p: THREE.Vector3, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: number) =>
  p.x > x0 - m && p.x < x1 + m && p.y > y0 - m && p.y < y1 + m && p.z > z0 - m && p.z < z1 + m;

/**
 * Classify a point (unit coordinates) with a clearance `m`: 'wall' if it's within `m` of the
 * structure, else 'outside'. Everything's open, so there's no inside.
 */
export function skyWhereIs(p: THREE.Vector3, m: number): Where {
  const hl = DECK_L / 2,
    hw = DECK_W / 2;
  if (Math.abs(p.x) > hl + m || Math.abs(p.y) > hw + m || p.z > ISL_Z + m || p.z < HULL_Z - m) return 'outside';
  if (nearBox(p, -hl, hl, -hw, hw, -DECK_T, 0, m)) return 'wall'; // the deck
  if (nearBox(p, ISL_X0, ISL_X1, ISL_Y0, ISL_Y1, 0, ISL_Z, m)) return 'wall'; // the island
  if (nearBox(p, HULL_X0, HULL_X1, -HULL_HW, HULL_HW, HULL_Z, -DECK_T, m)) return 'wall'; // the hull
  if (p.z < -DECK_T && p.z > POD_Z - m)
    for (let k = 0; k < 2 * POD_N; k++) {
      const [x, y] = podAt(k);
      if (Math.hypot(p.x - x, p.y - y) < POD_R + m) return 'wall';
    }
  return 'outside';
}

/** Is a point (unit coordinates) over the deck (within `m` of its outline, seen from above)? */
export const overDeck = (p: THREE.Vector3, m = 0) => Math.abs(p.x) < DECK_L / 2 + m && Math.abs(p.y) < DECK_W / 2 + m;
