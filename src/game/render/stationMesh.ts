/*
 * Station geometry, in unit coordinates (the cube is −0.5…0.5; the mesh is scaled by the station's
 * size), matching sim/stationGeom.ts:
 *
 *   hull   — the cube's six faces, with the docking slot cut out of the front (+z) face
 *   inside — the slot tunnel's four walls, the hangar cylinder, its back wall, and its front wall
 *            with the slot in it; all facing inward, drawn with the interior shader
 *
 * Built once and shared by every station.
 */
import { THREE } from '../lib/three';
import { HANGAR_R, HANGAR_Z0, HANGAR_Z1, SLOT_H, SLOT_W, TUNNEL_Z } from '../sim/stationGeom';

type V3 = [number, number, number];

/** Append a quad (a, b, c, d counter-clockwise seen from the side `n` points to). */
function quad(pos: number[], nor: number[], a: V3, b: V3, c: V3, d: V3, n: V3) {
  for (const p of [a, b, c, a, c, d]) {
    pos.push(...p);
    nor.push(...n);
  }
}

function geometry(pos: number[], nor: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** The cube's outer skin with the slot cut out of the front face. */
export function hullGeometry() {
  const pos: number[] = [],
    nor: number[] = [];
  const h = 0.5,
    sx = SLOT_W / 2,
    sy = SLOT_H / 2;
  // back (−z), sides and top/bottom
  quad(pos, nor, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
  quad(pos, nor, [h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]);
  quad(pos, nor, [-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]);
  quad(pos, nor, [-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]);
  quad(pos, nor, [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]);
  // front (+z) around the slot: top and bottom strips, left and right of the slot
  const f: V3 = [0, 0, 1];
  quad(pos, nor, [-h, sy, h], [h, sy, h], [h, h, h], [-h, h, h], f);
  quad(pos, nor, [-h, -h, h], [h, -h, h], [h, -sy, h], [-h, -sy, h], f);
  quad(pos, nor, [-h, -sy, h], [-sx, -sy, h], [-sx, sy, h], [-h, sy, h], f);
  quad(pos, nor, [sx, -sy, h], [h, -sy, h], [h, sy, h], [sx, sy, h], f);
  return geometry(pos, nor);
}

/** Inside: the slot tunnel, the hangar cylinder, and its back and front walls, facing inward. */
export function interiorGeometry() {
  const pos: number[] = [],
    nor: number[] = [];
  const sx = SLOT_W / 2,
    sy = SLOT_H / 2,
    z0 = TUNNEL_Z,
    z1 = 0.5;
  // tunnel walls (normals into the tunnel)
  quad(pos, nor, [-sx, sy, z1], [-sx, sy, z0], [sx, sy, z0], [sx, sy, z1], [0, -1, 0]);
  quad(pos, nor, [-sx, -sy, z0], [-sx, -sy, z1], [sx, -sy, z1], [sx, -sy, z0], [0, 1, 0]);
  quad(pos, nor, [-sx, -sy, z0], [-sx, sy, z0], [-sx, sy, z1], [-sx, -sy, z1], [1, 0, 0]);
  quad(pos, nor, [sx, -sy, z1], [sx, sy, z1], [sx, sy, z0], [sx, -sy, z0], [-1, 0, 0]);
  // hangar cylinder: normals toward the axis
  const N = 96;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2,
      a1 = ((i + 1) / N) * Math.PI * 2;
    const p = (a: number, z: number): V3 => [HANGAR_R * Math.cos(a), HANGAR_R * Math.sin(a), z];
    const am = (a0 + a1) / 2;
    quad(pos, nor, p(a0, HANGAR_Z1), p(a0, HANGAR_Z0), p(a1, HANGAR_Z0), p(a1, HANGAR_Z1), [-Math.cos(am), -Math.sin(am), 0]);
  }
  // back wall (facing +z, into the hangar)
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2,
      a1 = ((i + 1) / N) * Math.PI * 2;
    pos.push(0, 0, HANGAR_Z0, HANGAR_R * Math.cos(a0), HANGAR_R * Math.sin(a0), HANGAR_Z0, HANGAR_R * Math.cos(a1), HANGAR_R * Math.sin(a1), HANGAR_Z0);
    nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  }
  const g = geometry(pos, nor);
  // front wall with the slot in it (facing −z, into the hangar)
  const shape = new THREE.Shape().absarc(0, 0, HANGAR_R, 0, Math.PI * 2, false);
  shape.holes.push(new THREE.Path().moveTo(-sx, -sy).lineTo(sx, -sy).lineTo(sx, sy).lineTo(-sx, sy).lineTo(-sx, -sy));
  const front = new THREE.ShapeGeometry(shape, 48).toNonIndexed();
  front.rotateY(Math.PI); // face −z (the hole is symmetric, so the mirror doesn't matter)
  front.translate(0, 0, HANGAR_Z1);
  return mergeInto(g, front);
}

/** Concatenate two non-indexed geometries with position and normal attributes. */
function mergeInto(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const cat = (name: string) => {
    const x = a.getAttribute(name).array as Float32Array,
      y = b.getAttribute(name).array as Float32Array;
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return new THREE.Float32BufferAttribute(out, 3);
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', cat('position'));
  g.setAttribute('normal', cat('normal'));
  return g;
}
