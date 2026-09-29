/*
 * Line of sight: is a world (or the star) in the way between two points? The HUD uses it to mark a
 * station on the far side of a world (a crossed square) and to hide other ships you can't see.
 * Worlds are spheres at their mean radius; the terrain's few km don't matter at these distances.
 */
import { THREE } from '../lib/three';
import type { Body } from '../types';

const ab = new THREE.Vector3(),
  ac = new THREE.Vector3();

/** The first body whose sphere the segment from → to passes through, or null if the view is clear. */
export function occluder(bodies: readonly Body[], from: THREE.Vector3, to: THREE.Vector3): Body | null {
  ab.subVectors(to, from);
  const len2 = ab.lengthSq();
  if (len2 < 1e-6) return null;
  for (const b of bodies) {
    ac.subVectors(b.pos, from);
    const t = ac.dot(ab) / len2;
    if (t <= 0 || t >= 1) continue; // the body is behind you or beyond the thing you're looking at
    // closest approach of the line to the body's centre, squared
    const d2 = ac.lengthSq() - t * t * len2;
    if (d2 < b.radius * b.radius) return b;
  }
  return null;
}
