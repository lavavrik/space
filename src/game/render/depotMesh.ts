/*
 * A depot's mesh, in unit coordinates (scaled by its spine's length), matching sim/depotGeom.ts:
 * +z up out of the landing plate (its top at z = 0), +x along the spine. Boxes (spine, habitat,
 * radiator fins, solar wings), a disc (the plate), spheres (the tanks) and a mast, each face with
 * its own normal so edges stay crisp (the spheres smooth). Drawn with shaders/depot.wgsl, which
 * paints the pads, lattice, panels and lights from the object-space position. Built once, shared
 * by every depot.
 */
import { THREE } from '../lib/three';
import { FIN, HAB, MAST, PLATE_R, PLATE_T, PLATE_X, SPINE_HW, SPINE_X0, SPINE_X1, SPINE_Z0, SPINE_Z1, TANK_DIRS, TANK_RINGS, WING, SPINE_ZC } from '../sim/depotGeom';

/** A box [x0, x1] × [y0, y1] × [z0, z1], every face facing out. */
function box(pos: number[], nor: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(...v);
      nor.push(...n);
    }
  };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
}

/**
 * A band of a surface of revolution about (cx, cy) from profile point (r0, z0) to (r1, z1); its
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

/** A smooth sphere of radius r about (cx, cy, cz). */
function sphere(pos: number[], nor: number[], cx: number, cy: number, cz: number, r: number, lon = 28, lat = 16) {
  const at = (i: number, j: number) => {
    const th = (j / lat) * Math.PI,
      ph = (i / lon) * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    return { p: [cx + r * n[0], cy + r * n[1], cz + r * n[2]], n };
  };
  for (let j = 0; j < lat; j++)
    for (let i = 0; i < lon; i++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      for (const v of [a, b, c, a, c, d]) {
        pos.push(...v.p);
        nor.push(...v.n);
      }
    }
}

export function depotGeometry() {
  const pos: number[] = [],
    nor: number[] = [];
  // the landing plate: top, rim and underside
  band(pos, nor, 0, 0, PLATE_R, 0, 64, PLATE_X, 0);
  band(pos, nor, PLATE_R, 0, PLATE_R, -PLATE_T, 64, PLATE_X, 0);
  band(pos, nor, PLATE_R, -PLATE_T, 0, -PLATE_T, 64, PLATE_X, 0);
  // the spine, and the habitat block under the plate
  box(pos, nor, SPINE_X0, SPINE_X1, -SPINE_HW, SPINE_HW, SPINE_Z0, SPINE_Z1);
  box(pos, nor, HAB.x0, HAB.x1, -HAB.hw, HAB.hw, HAB.z0, HAB.z1);
  // radiator fins hanging under the spine, solar wings flat either side
  for (const s of [-1, 1]) {
    box(pos, nor, FIN.x0, FIN.x1, s * FIN.y - FIN.t, s * FIN.y + FIN.t, FIN.z0, FIN.z1);
    box(pos, nor, WING.x0, WING.x1, s > 0 ? WING.y0 : -WING.y1, s > 0 ? WING.y1 : -WING.y0, WING.z - WING.t, WING.z + WING.t);
  }
  // the tank farm: two rings of four spheres round the spine
  for (const ring of TANK_RINGS) for (const d of TANK_DIRS) sphere(pos, nor, ring.x, d[0] * ring.off, SPINE_ZC + d[1] * ring.off, ring.r);
  // the beacon mast at the tank end, going down (so its normals face out)
  band(pos, nor, MAST.r, MAST.z1, MAST.r, SPINE_Z1, 8, MAST.x, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
