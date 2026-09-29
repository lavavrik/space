import { describe, expect, it } from 'vitest';
import { JUMP_RANGE } from '../constants';
import { THREE } from '../lib/three';
import { minOrbitAlt } from '../sim/orbits';
import { updateBodies } from '../sim/kepler';
import { stationAcc, stationState } from '../sim/stations';
import { atmoOf } from '../sim/atmosphere';
import { skyWhereIs } from '../sim/skyGeom';
import { padCount, padOf, stationQuat } from '../sim/stationGeom';
import { altitudeAt, elevationLocal, hasSea } from '../sim/terrain';
import { populated, population } from '../sim/population';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem, findHome } from '../universe/system';

const systems = systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 40);
const every = systems.flatMap((sys) => {
  const bodies = buildSystem(sys);
  return buildStations(sys, bodies).map((st) => ({ st, bodies }));
});
/** The orbital stations, and the sky stations. */
const all = every.filter(({ st }) => !st.sky);
const skies = every.filter(({ st }) => st.sky);

describe('stations', () => {
  it('orbit the home world', () => {
    const sys = homeSystem();
    const bodies = buildSystem(sys);
    expect(buildStations(sys, bodies).some((st) => st.parent === findHome(bodies))).toBe(true);
  });

  it('are the same on every visit', () => {
    const sys = systems[3];
    const a = buildStations(sys, buildSystem(sys)),
      b = buildStations(sys, buildSystem(sys));
    expect(a.map((s) => [s.name, s.a, s.e, s.pos.toArray()])).toEqual(b.map((s) => [s.name, s.a, s.e, s.pos.toArray()]));
  });

  it('orbit some worlds but not all', () => {
    const worlds = systems.flatMap((sys) => buildSystem(sys).filter((b) => b.kind !== 'star')).length;
    expect(all.length).toBeGreaterThan(worlds * 0.1);
    expect(all.length).toBeLessThan(worlds * 0.6);
  });

  it('are about the size of an Elite Dangerous station', () => {
    for (const { st } of all) {
      expect(st.size).toBeGreaterThanOrEqual(1000);
      expect(st.size).toBeLessThanOrEqual(1600);
    }
  });

  it('keep realistic orbits: near-circular, above the atmosphere, inside the SOI, below the moons, clear of rings', () => {
    for (const { st, bodies } of all) {
      const p = st.parent;
      expect(st.e).toBeLessThanOrEqual(0.02);
      expect(st.a * (1 - st.e)).toBeGreaterThanOrEqual(p.radius + minOrbitAlt(p));
      expect(st.a * (1 + st.e)).toBeLessThan(p.soi);
      for (const m of bodies) if (m.kind === 'moon' && m.parent === p) expect(st.a).toBeLessThan(m.orbit);
      if (p.ring) expect(st.a < p.radius * p.ring.inner || st.a > p.radius * p.ring.outer).toBe(true);
    }
  });

  it('follow Kepler orbits around their moving worlds', () => {
    for (const { st, bodies } of all.slice(0, 30)) {
      const p = st.parent,
        mu = p.mu;
      const T = (2 * Math.PI) / st.n;
      const relAt = (t: number) => {
        updateBodies(bodies, t);
        stationState(st, t);
        return { r: st.pos.clone().sub(p.pos), v: st.vel.clone().sub(p.vel) };
      };
      for (const t of [0, 1234.5, T * 0.37]) {
        const { r: rv, v } = relAt(t);
        const r = rv.length();
        expect(r).toBeGreaterThanOrEqual(st.a * (1 - st.e) * (1 - 1e-9));
        expect(r).toBeLessThanOrEqual(st.a * (1 + st.e) * (1 + 1e-9));
        // vis-viva: v² = μ(2/r − 1/a)
        expect(v.lengthSq() / (mu * (2 / r - 1 / st.a))).toBeCloseTo(1, 6); // subtracting ~30 km/s parent speeds costs digits
        const r1 = relAt(t + T).r;
        expect(r1.distanceTo(rv) / st.a).toBeLessThan(1e-6);
      }
    }
  });
});

describe('sky stations', () => {
  it('hang over some worlds with air and ground, and always the home world', () => {
    expect(skies.length).toBeGreaterThan(3);
    for (const { st } of skies) {
      expect(atmoOf(st.parent)).not.toBeNull();
      expect(st.parent.type).toBeLessThan(6); // not the giants
    }
    const sys = homeSystem();
    const bodies = buildSystem(sys);
    expect(buildStations(sys, bodies).some((st) => st.sky && st.parent === findHome(bodies))).toBe(true);
  });

  it('have unique names, shared with the orbital ones', () => {
    for (const sys of systems.slice(0, 20)) {
      const names = buildStations(sys, buildSystem(sys)).map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('stay 10–20 km over the same spot on the ground, turning with the world', () => {
    for (const { st, bodies } of skies.slice(0, 20)) {
      const p = st.parent;
      for (const t of [0, 5000, 86400 * 3.3]) {
        updateBodies(bodies, t);
        stationState(st, t);
        const h = altitudeAt(p, st.pos);
        expect(h).toBeGreaterThan(10e3 - 1);
        expect(h).toBeLessThan(20e3 + 1);
        // its velocity is the ground's there (ω × r), and its up is away from the world's centre
        const r = st.pos.clone().sub(p.pos);
        const ground = p.axis.clone().multiplyScalar(p.spin).cross(r);
        expect(st.vel.clone().sub(p.vel).distanceTo(ground)).toBeLessThan(1e-6);
        const up = new THREE.Vector3(0, 0, 1).applyQuaternion(stationQuat(st, t));
        expect(up.dot(r.normalize())).toBeCloseTo(1, 9);
        // held up: its acceleration is only the turn (ω²r across the axis), a few % of gravity
        const acc = stationAcc(st);
        expect(acc.length()).toBeCloseTo(p.spin * p.spin * Math.sqrt(r.lengthSq() - r.dot(p.axis) ** 2) * st.pos.distanceTo(p.pos), 9);
        expect(acc.length()).toBeLessThan((0.05 * p.mu) / p.radius ** 2);
      }
    }
  });

  it('keep their pads on the open deck, clear of the tower', () => {
    const st = skies[0].st;
    for (let i = 0; i < padCount(st); i++) {
      const p = padOf(st, i);
      expect(skyWhereIs(p.pos.clone().setZ(0.02), 0.008)).toBe('outside'); // 20 m over the pad
      expect(skyWhereIs(p.pos.clone().setZ(0.002), 0.008)).toBe('wall'); // on it
      for (let j = 0; j < i; j++) expect(padOf(st, j).pos.distanceTo(p.pos)).toBeGreaterThan(0.09);
    }
    expect(skyWhereIs(new THREE.Vector3(0, 0, 0.08), 0.008)).toBe('wall'); // the tower
    expect(skyWhereIs(new THREE.Vector3(0, 0, -0.2), 0.008)).toBe('wall'); // the keel
    expect(skyWhereIs(new THREE.Vector3(0.3, 0, -0.2), 0.008)).toBe('outside'); // under the deck, beside the keel
  });

  it('hang over the cities on populated worlds, and over land where there is a sea', () => {
    for (const { st } of skies) {
      const { dir } = st.sky!;
      if (populated(st.parent)) expect(population(st.parent, dir.x, dir.y, dir.z)).toBeGreaterThan(0.3);
      else if (hasSea(st.parent)) expect(elevationLocal(st.parent, dir.x, dir.y, dir.z)).toBeGreaterThan(0);
    }
  });
});
