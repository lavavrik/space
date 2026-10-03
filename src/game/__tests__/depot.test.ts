import { describe, expect, it } from 'vitest';
import { JUMP_RANGE, WT } from '../constants';
import { THREE } from '../lib/three';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { DEPOT_PAD_COUNT, PAD_RING, PLATE_R, PLATE_X, depotPadLocal, depotWhereIs, overPlate } from '../sim/depotGeom';
import { isDeck, orbitBody, padCount, padOf, stationQuat, whereIsAt } from '../sim/stationGeom';
import { stationAcc, stationState } from '../sim/stations';
import type { Station, World } from '../types';
import { systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildTrojans } from '../universe/trojans';
import { buildSystem } from '../universe/system';

const systems = systemsNear(new THREE.Vector3(), JUMP_RANGE).slice(0, 60);
const built = systems.map((sys) => {
  const bodies = buildSystem(sys);
  updateBodies(bodies, 0);
  return { sys, bodies, stations: buildStations(sys, bodies) };
});
const depots = built.flatMap((b) => b.stations.filter((s) => s.depot).map((st) => ({ st, ...b })));

describe('depots', () => {
  it('are parked in some systems, mostly at giants', () => {
    expect(depots.length).toBeGreaterThan(3);
    const giants = depots.filter(({ st }) => st.parent.type >= WT.GasGiant).length;
    expect(giants).toBeGreaterThan(depots.length * 0.4);
    for (const { st } of depots) {
      expect(st.parent.kind).toBe('planet');
      expect(st.depot!.k === 4 || st.depot!.k === 5).toBe(true);
      expect(st.size).toBeGreaterThanOrEqual(900);
      expect(st.size).toBeLessThanOrEqual(1300);
      expect(isDeck(st)).toBe(true);
      expect(st.sky).toBeUndefined();
    }
  });

  it('are the same on every visit, with unique names', () => {
    const a = built[7];
    const again = buildStations(a.sys, buildSystem(a.sys));
    expect(again.map((s) => s.name)).toEqual(a.stations.map((s) => s.name));
    for (const b of built) expect(new Set(b.stations.map((s) => s.name)).size).toBe(b.stations.length);
  });

  it('keep company with their planet for ever, on a free orbit round its parent', () => {
    for (const { st, bodies } of depots.slice(0, 8)) {
      const w = st.parent as World;
      expect(orbitBody(st)).toBe(w.parent);
      for (const t of [0, 3e7, 2.2e8, 9e8]) {
        updateBodies(bodies, t);
        stationState(st, t);
        const point = lagrangePoints(w)[st.depot!.k - 1];
        const r = w.pos.distanceTo(w.parent.pos);
        // within the swarm of its point: a fraction of the orbit's radius away, never more
        expect(st.pos.distanceTo(point.pos)).toBeLessThan(0.12 * r);
        // a free orbit: nothing but the parent's pull accelerates it (relative to the parent)
        const g = stationAcc(st);
        const rel = st.pos.clone().sub(w.parent.pos);
        expect(g.distanceTo(rel.clone().multiplyScalar(-w.parent.mu / rel.length() ** 3))).toBeLessThan(1e-12);
      }
    }
  });

  it('keep one attitude in space, +z along the orbit normal', () => {
    const { st } = depots[0];
    const q0 = stationQuat(st, 0),
      q1 = stationQuat(st, 5e7);
    expect(q0.angleTo(q1)).toBe(0);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q0);
    expect(z.distanceTo(new THREE.Vector3().crossVectors(st.P, st.Q).normalize())).toBeLessThan(1e-9);
    expect(st.spinRate).toBe(0);
  });

  it('have 8 pads ringed on an open plate, clear of the plate\'s edge', () => {
    const { st } = depots[0];
    expect(padCount(st)).toBe(DEPOT_PAD_COUNT);
    for (let i = 0; i < DEPOT_PAD_COUNT; i++) {
      const pad = padOf(st, i);
      expect(pad.pos.z).toBe(0);
      expect(pad.up.z).toBe(1);
      expect(overPlate(pad.pos, -0.05)).toBe(true); // well inside the plate, a pad's radius (0.04) from the edge
      // the plate holds a ship that touches down on it; open space a little above it
      const m = 8 / st.size;
      expect(whereIsAt(st, pad.pos.clone().setZ(0.0005), m)).toBe('wall');
      expect(whereIsAt(st, pad.pos.clone().setZ(0.5), m)).toBe('outside');
    }
    // pads don't overlap
    for (let i = 1; i < DEPOT_PAD_COUNT; i++) expect(depotPadLocal(i).pos.distanceTo(depotPadLocal(0).pos)).toBeGreaterThan(0.08);
    expect(PAD_RING + 0.04).toBeLessThan(PLATE_R);
  });

  it('are solid where they look solid: plate, spine, tanks, wings; open elsewhere', () => {
    const m = 0.002;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    expect(depotWhereIs(V(PLATE_X, 0, -0.005), m)).toBe('wall'); // the plate
    expect(depotWhereIs(V(-0.1, 0, -0.06), m)).toBe('wall'); // the spine
    expect(depotWhereIs(V(-0.43, 0.075, -0.0625), m)).toBe('wall'); // a tank
    expect(depotWhereIs(V(-0.12, 0.2, -0.0625), m)).toBe('wall'); // a solar wing
    expect(depotWhereIs(V(0.3, 0.5, 0), m)).toBe('outside'); // off to the side
    expect(depotWhereIs(V(0.3, 0, 0.3), m)).toBe('outside'); // over the plate
    expect(depotWhereIs(V(0.0, 0.0, 0.0), m)).toBe('outside'); // above the spine amidships
    expect(depotWhereIs(V(2, 2, 2), m)).toBe('outside');
  });

  it('are listed with their swarms', () => {
    // every depot sits at a point that has a swarm or is beside a habitable world
    for (const { st, sys, bodies } of depots) {
      const { sites } = buildTrojans(sys, bodies);
      expect(sites.some((s) => s.planet === st.parent && s.k === st.depot!.k)).toBe(true);
    }
    const _ = null as null | Station;
    void _;
  });
});
