/*
 * A trojan swarm's rock mesh (render/swarmMesh.ts, gpu/shaders/swarmRock.wgsl): a unit icosphere,
 * subdivided twice (320 triangles), as directions: the vertex shader pushes each out by the rock's
 * own noise and scales it. Built once, shared by every rock. And the packing of a rock's per-instance
 * data (what the shader's VIn reads), kept here so a test can check it without a GPU.
 */
import { THREE } from '../lib/three';
import { rockShape } from '../sim/ringRocks';
import { TROJAN_METAL_RICH } from '../sim/laser';
import type { SwarmRock } from '../sim/swarm';

/** Floats per instance: p (xyz, tint), q, sc (xyz, metal), o (xyz, seed). */
export const SWARM_INSTANCE_FLOATS = 16;

/** The unit icosphere's triangles, non-indexed (3 floats a vertex). */
export function swarmSphere(subdivisions = 2): Float32Array<ArrayBuffer> {
  const t = (1 + Math.sqrt(5)) / 2;
  let v: THREE.Vector3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());
  let f: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = cache.get(k);
      if (i === undefined) {
        i = v.length;
        v.push(v[a].clone().add(v[b]).normalize());
        cache.set(k, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = next;
  }
  const out = new Float32Array(f.length * 9);
  f.forEach((tri, i) => tri.forEach((vi, j) => out.set([v[vi].x, v[vi].y, v[vi].z], i * 9 + j * 3)));
  v = [];
  return out;
}

/** Pack a rock into `out` at instance slot `i`; `rel` is its centre relative to the camera, `fade` (0–1) shrinks it away. */
export function packSwarmRock(out: Float32Array, i: number, rock: SwarmRock, rel: THREE.Vector3, fade: number) {
  const { q, sc, o } = rockShape({ ...rock, size: rock.size * fade });
  out.set(
    [rel.x, rel.y, rel.z, rock.tint, q.x, q.y, q.z, q.w, sc.x, sc.y, sc.z, rock.tint < TROJAN_METAL_RICH ? 1 : 0, o.x, o.y, o.z, (rock.shapeSeed % 997) / 997],
    i * SWARM_INSTANCE_FLOATS,
  );
}
