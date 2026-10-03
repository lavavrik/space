import { describe, expect, it } from 'vitest';
import { WT } from '../constants';
import type { Game } from '../Game';
import { buildInfo } from '../hud/info';
import { THREE } from '../lib/three';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { lpointFor, lpointsHere } from '../sim/lpoints';
import { contactLabel, known } from '../sim/radar';
import { scanKey, scanProgress } from '../sim/scanner';
import type { CurrentSystem, Ship, Star, World } from '../types';
import { homeSystem } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';
import { buildTrojans } from '../universe/trojans';

function setup() {
  const sys = homeSystem();
  const bodies = buildSystem(sys);
  updateBodies(bodies, 1e6);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [], trojans: buildTrojans(sys, bodies).fields };
  const seen = new Set<string>();
  const ship = { pos: new THREE.Vector3(1e11, 0, 0), vel: new THREE.Vector3(), mode: 'normal' } as unknown as Ship;
  const g = { cur, simTime: 1e6, radar: { seen }, scans: new Map(), ship, frameBody: stars[0] } as unknown as Game;
  return { g, cur, bodies, seen };
}

describe('Lagrange points as targets', () => {
  it('are offered for the planets the radar has found, five each, and for no others', () => {
    const { g, cur, seen } = setup();
    expect(lpointsHere(g)).toHaveLength(0);
    const w = findHome(cur.bodies) as World;
    seen.add(scanKey(cur.sys, w));
    const pts = lpointsHere(g);
    expect(pts).toHaveLength(5);
    expect(pts.map((p) => p.k)).toEqual([1, 2, 3, 4, 5]);
    expect(pts.every((p) => p.planet === w && p.kind === 'lpoint')).toBe(true);
    expect(known(g, pts[0])).toBe(true);
    expect(contactLabel(g, pts[3])).toBe(`${w.name} L4`);
    expect(scanProgress(g, pts[0])).toBe(1);
  });

  it('keep their identity and follow the planet: the same object, a new place', () => {
    const { g, cur, bodies, seen } = setup();
    const w = findHome(cur.bodies) as World;
    seen.add(scanKey(cur.sys, w));
    const a = lpointsHere(g)[3];
    const p0 = a.pos.clone();
    updateBodies(bodies, 3e6);
    g.simTime = 3e6;
    const b = lpointsHere(g)[3];
    expect(b).toBe(a);
    expect(a.pos.distanceTo(p0)).toBeGreaterThan(1e9);
    const want = lagrangePoints(w)[3];
    expect(a.pos.distanceTo(want.pos)).toBeLessThan(1);
    expect(a.vel.distanceTo(want.vel)).toBeLessThan(1e-6);
    expect(lpointFor(g, w, 4)).toBe(a);
  });

  it('have an info panel: where, what a ship left there does, the swarm and the depot', () => {
    const { g, cur, seen } = setup();
    const giant = cur.bodies.find((b): b is World => b.kind === 'planet' && b.type >= WT.GasGiant);
    expect(giant).toBeTruthy();
    seen.add(scanKey(cur.sys, giant!));
    const l4 = lpointsHere(g).find((p) => p.planet === giant && p.k === 4)!;
    const info = buildInfo(g, l4);
    expect(info.type).toBe('LAGRANGE POINT');
    expect(info.title).toBe(`${giant!.name} L4`);
    expect(info.physical.map((r) => r[0])).toEqual(['WHERE', 'A SHIP LEFT HERE']);
    expect(info.physical[1][1]).toMatch(/stays/);
    expect(info.orbit.some((r) => r[0] === 'SWARM')).toBe(true);
    const l1 = lpointsHere(g).find((p) => p.planet === giant && p.k === 1)!;
    expect(buildInfo(g, l1).physical[1][1]).toMatch(/drifts away/);
  });
});
