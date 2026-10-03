import { describe, expect, it } from 'vitest';
import { JUMP_RANGE, WT } from '../constants';
import type { Game } from '../Game';
import { buildInfo } from '../hud/info';
import { THREE } from '../lib/three';
import { updateBodies } from '../sim/kepler';
import { lagrangePoints } from '../sim/lagrange';
import { lpointFor, lpointsHere } from '../sim/lpoints';
import { contactLabel, known } from '../sim/radar';
import { scanKey, scanProgress } from '../sim/scanner';
import type { CurrentSystem, Ship, Star, Target, World } from '../types';
import { homeSystem, systemsNear } from '../universe/galaxy';
import { buildSystem, findHome, systemAnchor } from '../universe/system';
import { buildTrojans } from '../universe/trojans';

/** The nearest system with a gas or ice giant (only they hold swarms). */
function giantSystem() {
  for (const sys of systemsNear(new THREE.Vector3(), JUMP_RANGE)) {
    if (buildSystem(sys).some((b) => b.kind === 'planet' && b.type >= WT.GasGiant)) return sys;
  }
  throw new Error('no giant nearby');
}

function setup(sys = homeSystem()) {
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
    const { g, cur, seen } = setup(giantSystem());
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

/* ---------- which points show, and the target kept current ---------- */
import { cycleTarget } from '../sim/navigation';
import { lpointsShown, refreshTarget } from '../sim/lpoints';

describe('which Lagrange points show', () => {
  it('only the targeted planet\'s five, or its points\' while one of them is the target; none otherwise', () => {
    const { g, cur, seen } = setup();
    const planets = cur.bodies.filter((b): b is World => b.kind === 'planet');
    for (const w of planets) seen.add(scanKey(cur.sys, w));
    const [a, b] = planets;
    expect(lpointsShown(g)).toHaveLength(0); // nothing targeted
    g.target = cur.star;
    expect(lpointsShown(g)).toHaveLength(0);
    g.target = a;
    expect(lpointsShown(g).map((p) => p.name)).toEqual([1, 2, 3, 4, 5].map((k) => `${a.name} L${k}`));
    g.target = lpointFor(g, a, 2);
    expect(lpointsShown(g).every((p) => p.planet === a)).toBe(true);
    expect(lpointsShown(g)).toContain(g.target);
    g.target = b;
    expect(lpointsShown(g).every((p) => p.planet === b)).toBe(true);
  });

  it('G never jumps to a point unless its planet (or a sibling point) is the target', () => {
    const { g, cur, seen } = setup();
    const planets = cur.bodies.filter((b): b is World => b.kind === 'planet');
    for (const w of planets) seen.add(scanKey(cur.sys, w));
    const [a, b] = planets;
    g.showMsg = () => {};
    g.traffic = [];
    g.wrecks = [];
    g.ship.pos.copy(lagrangePoints(b)[3].pos).add(new THREE.Vector3(1e3, 0, 0)); // sitting by b's L4
    for (let i = 0; i < 60; i++) {
      const before = g.target;
      const shown = before?.kind === 'planet' ? before : before?.kind === 'lpoint' ? before.planet : null;
      cycleTarget(g);
      if (g.target?.kind === 'lpoint') expect(g.target.planet).toBe(shown);
    }
    // and from a, b's L4 (the nearest thing of all) is not offered
    g.target = a;
    cycleTarget(g);
    const t = g.target as Target;
    expect(t.kind === 'lpoint' && t.planet === b).toBe(false);
  });

  it('a targeted point is brought up to the step without anything drawing it', () => {
    const { g, cur, bodies, seen } = setup();
    const w = findHome(cur.bodies) as World;
    seen.add(scanKey(cur.sys, w));
    g.target = lpointFor(g, w, 1);
    updateBodies(bodies, 2e6);
    g.simTime = 2e6;
    refreshTarget(g);
    expect(g.target.pos.distanceTo(lagrangePoints(w)[0].pos)).toBeLessThan(1);
  });
});
