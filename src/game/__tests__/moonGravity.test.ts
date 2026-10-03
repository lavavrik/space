import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { THREE } from '../lib/three';
import { gravityAt } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import type { Body, CurrentSystem, Star, World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, systemAnchor } from '../universe/system';

function curOf(sys: ReturnType<typeof homeSystem>, bodies: Body[]): CurrentSystem {
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  return { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [] };
}

/** A body's own acceleration on its rails (its Kepler orbit round its parent, plus the parent's): what its frame carries the ship with. */
function railAcc(b: Body): THREE.Vector3 {
  if (b.kind === 'star') return new THREE.Vector3();
  const r = b.pos.clone().sub(b.parent.pos);
  const o = b.orb;
  return r.multiplyScalar((-o.n * o.n * o.a ** 3) / r.length() ** 3).add(railAcc(b.parent));
}

/** The acceleration (inertial) a ship at `p` feels: its frame body's own plus the pull relative to it. */
function inertial(cur: CurrentSystem, p: THREE.Vector3) {
  const g = gravityAt(cur, p);
  return { body: g.body, acc: g.vec.clone().add(railAcc(g.body)) };
}

/** Moons of the nearby systems, the bodies moved somewhere along their orbits. */
function* moons() {
  for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 30)) {
    const bodies = buildSystem(sys);
    updateBodies(bodies, 4.2e6);
    const cur = curOf(sys, bodies);
    for (const m of bodies) if (m.kind === 'moon') yield { m: m as World, cur };
  }
}

describe('moons in their planet\'s frame', () => {
  it('pull a ship outside their SOI too, so crossing its edge doesn\'t jolt it', () => {
    let n = 0;
    for (const { m, cur } of moons()) {
      const away = m.pos.clone().sub(m.parent.pos).normalize();
      const side = new THREE.Vector3().crossVectors(away, m.vel.clone().sub(m.parent.vel)).normalize();
      for (const dir of [away, away.clone().negate(), side]) {
        const inn = inertial(cur, m.pos.clone().addScaledVector(dir, m.soi * 0.9999));
        const out = inertial(cur, m.pos.clone().addScaledVector(dir, m.soi * 1.0001));
        if (inn.body !== m || out.body !== m.parent) continue; // (another SOI there)
        const moonPull = m.mu / m.soi ** 2;
        // (the old switch jumped by the moon's whole pull)
        expect(inn.acc.distanceTo(out.acc) / moonPull).toBeLessThan(0.01);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it('still leave the planet\'s own SOI edge continuous: a moon\'s reach ends inside it', () => {
    for (const { m, cur } of moons()) {
      const p = m.parent as World;
      const dir = m.pos.clone().sub(p.pos).normalize(); // the edge on the moon's side, where its pull would reach
      const inn = inertial(cur, p.pos.clone().addScaledVector(dir, p.soi * 0.9999));
      const out = inertial(cur, p.pos.clone().addScaledVector(dir, p.soi * 1.0001));
      if (inn.body !== p || out.body !== p.parent) continue;
      expect(inn.acc.distanceTo(out.acc) / out.acc.length()).toBeLessThan(2e-3);
    }
  });
});
