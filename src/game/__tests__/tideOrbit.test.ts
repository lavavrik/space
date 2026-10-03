import { describe, expect, it } from 'vitest';
import { THREE } from '../lib/three';
import { ORBIT_BAND, orbitBandAlt } from '../sim/autopilot';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import { maxOrbitR } from '../sim/orbits';
import type { CurrentSystem, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

/**
 * Coast a circular equatorial orbit of radius r0 round the home world for `orbits` turns under the
 * game's force (the world's pull plus its parent's tide near the SOI edge), carried with the world
 * as the frame body is. Returns the largest altitude and speed errors against a circular orbit.
 */
function coast(r0: number, orbits: number) {
  const bodies = buildSystem(homeSystem());
  const w = findHome(bodies) as World;
  updateBodies(bodies, 0);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys: homeSystem(), bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
  const up = w.axis.clone();
  const u = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
  const pos = w.pos.clone().addScaledVector(u, r0);
  const vel = up.clone().cross(u).multiplyScalar(Math.sqrt(w.mu / r0));
  const period = 2 * Math.PI * Math.sqrt(r0 ** 3 / w.mu);
  const dt = period / 4000;
  let dr = 0,
    dv = 0,
    left = false;
  for (let t = 0; t < orbits * period; t += dt) {
    const grav = gravityAt(cur, pos);
    if (grav.body !== w) {
      left = true;
      break;
    }
    vel.addScaledVector(grav.vec, dt); // (kick, then drift: symplectic, like the rails)
    const before = w.pos.clone();
    updateBodies(bodies, t + dt);
    pos.add(w.pos.clone().sub(before)).addScaledVector(vel, dt);
    const rel = pos.clone().sub(w.pos);
    dr = Math.max(dr, Math.abs(rel.length() - r0));
    dv = Math.max(dv, vel.clone().sub(up.clone().cross(rel).setLength(Math.sqrt(w.mu / rel.length()))).length());
  }
  return { left, dr, dv, band: orbitBandAlt(r0, Math.sqrt(w.mu / r0)) };
}

describe('orbits and the parent\'s tide', () => {
  it('the highest orbit the planner offers stays a settled orbit: inside the autopilot\'s band for three turns', () => {
    const w = findHome(buildSystem(homeSystem())) as World;
    const r = coast(maxOrbitR(w), 3);
    expect(r.left).toBe(false);
    expect(r.dr).toBeLessThan(r.band);
    expect(r.dv).toBeLessThan(ORBIT_BAND.vel);
  });

  it('(where the old 0.8 SOI ceiling was, the tide pulls the orbit apart: the reason for the cap)', () => {
    const w = findHome(buildSystem(homeSystem())) as World;
    const r = coast(0.8 * w.soi, 3);
    expect(r.left || r.dr > r.band).toBe(true);
  });
});
