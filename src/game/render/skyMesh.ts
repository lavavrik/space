/*
 * A sky station's mesh, in unit coordinates (scaled by its deck's diameter), matching
 * sim/skyGeom.ts: +z up, the deck's top at z = 0. Everything is a surface of revolution — the deck,
 * the tower and cab, the keel, the lift-fan pods — built from profiles, each band with the normal of
 * its own slope so the edges stay crisp. Drawn with shaders/skyStation.frag.glsl, which paints the
 * pads, lights and panels from the object-space position. Built once, shared by every sky station.
 */
import { THREE } from '../lib/three';
import { CAB_R, CAB_Z0, CAB_Z1, DECK_R, DECK_T, KEEL_R0, KEEL_R1, KEEL_Z, POD_N, POD_R, POD_Z, TOWER_R, podAt } from '../sim/skyGeom';

/** The beacon mast on the cab's roof (unit coordinates): visual only, too thin to hit. */
export const MAST_R = 0.004,
  MAST_Z = 0.2;

/**
 * A band of a surface of revolution about (cx, cy) from profile point (r0, z0) to (r1, z1). Its
 * normal is (−dz, dr) in the (radial, z) plane: walk the profile with the outside on your left.
 */
function band(pos: number[], nor: number[], r0: number, z0: number, r1: number, z1: number, segs: number, cx = 0, cy = 0) {
  const dr = r1 - r0,
    dz = z1 - z0;
  const l = Math.hypot(dr, dz);
  const nr = -dz / l,
    nz = dr / l;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2,
      a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0),
      s0 = Math.sin(a0),
      c1 = Math.cos(a1),
      s1 = Math.sin(a1);
    const v = (r: number, z: number, c: number, s: number) => [cx + r * c, cy + r * s, z];
    const A = v(r0, z0, c0, s0),
      B = v(r0, z0, c1, s1),
      C = v(r1, z1, c1, s1),
      D = v(r1, z1, c0, s0);
    for (const [p, c, s] of [
      [A, c0, s0],
      [B, c1, s1],
      [C, c1, s1],
      [A, c0, s0],
      [C, c1, s1],
      [D, c0, s0],
    ] as [number[], number, number][]) {
      pos.push(...p);
      nor.push(nr * c, nr * s, nz);
    }
  }
}

export function skyStationGeometry() {
  const pos: number[] = [],
    nor: number[] = [];
  const S = 96;
  // the deck: top, rim, underside out to the keel
  band(pos, nor, 0, 0, DECK_R, 0, S);
  band(pos, nor, DECK_R, 0, DECK_R, -DECK_T, S);
  band(pos, nor, DECK_R, -DECK_T, KEEL_R0, -DECK_T, S);
  // the keel, and its flat bottom
  band(pos, nor, KEEL_R0, -DECK_T, KEEL_R1, KEEL_Z, S);
  band(pos, nor, KEEL_R1, KEEL_Z, 0, KEEL_Z, S);
  // the tower, the cab on top, the beacon mast
  band(pos, nor, TOWER_R, CAB_Z0, TOWER_R, 0, 32);
  band(pos, nor, CAB_R, CAB_Z0, TOWER_R, CAB_Z0, 32);
  band(pos, nor, CAB_R, CAB_Z1, CAB_R, CAB_Z0, 32);
  band(pos, nor, 0, CAB_Z1, CAB_R, CAB_Z1, 32);
  band(pos, nor, MAST_R, MAST_Z, MAST_R, CAB_Z1, 8);
  // lift-fan pods under the rim
  for (let k = 0; k < POD_N; k++) {
    const [x, y] = podAt(k);
    band(pos, nor, POD_R, -DECK_T, POD_R, POD_Z, 32, x, y);
    band(pos, nor, POD_R, POD_Z, 0, POD_Z, 32, x, y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
