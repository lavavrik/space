/*
 * A sky station's mesh, in unit coordinates (scaled by its deck's length), matching sim/skyGeom.ts:
 * +z up, the deck's top at z = 0, the bow at +x. A flying carrier: boxes (the flight deck, the hull
 * under it, the island) and cylinders (the lift-fan pods, the beacon mast), each face with its own
 * normal so the edges stay crisp. Drawn with shaders/skyStation.wgsl, which paints the pads,
 * markings, lights and panels from the object-space position. Built once, shared by every sky
 * station.
 */
import { THREE } from '../lib/three';
import { DECK_L, DECK_T, DECK_W, HULL_HW, HULL_X0, HULL_X1, HULL_Z, ISL_X0, ISL_X1, ISL_Y0, ISL_Y1, ISL_Z, POD_N, POD_R, POD_Z, podAt } from '../sim/skyGeom';

/** The beacon mast on the island's roof (unit coordinates): visual only, too thin to hit. */
export const MAST_R = 0.002,
  MAST_Z = 0.11;

/** A box [x0, x1] × [y0, y1] × [z0, z1], its faces facing out (the top only if `top`). */
function box(pos: number[], nor: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, top = true) {
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(...v);
      nor.push(...n);
    }
  };
  if (top) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
}

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
  const hl = DECK_L / 2,
    hw = DECK_W / 2;
  // the flight deck, the hull under it, the island on the starboard edge
  box(pos, nor, -hl, hl, -hw, hw, -DECK_T, 0);
  box(pos, nor, HULL_X0, HULL_X1, -HULL_HW, HULL_HW, HULL_Z, -DECK_T);
  box(pos, nor, ISL_X0, ISL_X1, ISL_Y0, ISL_Y1, 0, ISL_Z);
  // the beacon mast on the island's roof
  const mx = (ISL_X0 + ISL_X1) / 2,
    my = (ISL_Y0 + ISL_Y1) / 2;
  band(pos, nor, MAST_R, MAST_Z, MAST_R, ISL_Z, 8, mx, my);
  // lift-fan pods under the deck's overhang, both sides
  for (let k = 0; k < 2 * POD_N; k++) {
    const [x, y] = podAt(k);
    band(pos, nor, POD_R, -DECK_T, POD_R, POD_Z, 32, x, y);
    band(pos, nor, POD_R, POD_Z, 0, POD_Z, 32, x, y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
