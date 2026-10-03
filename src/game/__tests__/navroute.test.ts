import { describe, expect, it } from 'vitest';
import { JUMP_RANGE, jumpCost } from '../constants';
import { THREE } from '../lib/three';
import { searchPath } from '../sim/navroute';
import { homeSystem, systemsNear } from '../universe/galaxy';

const home = homeSystem();
const far = systemsNear(new THREE.Vector3(), 95)
  .filter((s) => s.pos.length() > 80)
  .sort((a, b) => b.pos.length() - a.pos.length())
  .slice(0, 4);

const hops = (path: ReturnType<typeof searchPath>) => {
  let at = home;
  return path!.map((s) => {
    const ly = s.pos.distanceTo(at.pos);
    at = s;
    return ly;
  });
};

describe('navigation route search', () => {
  it('finds a chain of jumps within range that ends at the destination', () => {
    for (const dest of far) {
      const path = searchPath(home, dest, 'exotic');
      expect(path).not.toBeNull();
      expect(path![path!.length - 1].id).toBe(dest.id);
      for (const ly of hops(path)) expect(ly).toBeLessThanOrEqual(JUMP_RANGE);
    }
  });

  it('optimises for its mode: fewest jumps has the fewest hops, least exotic the least exotic', () => {
    for (const dest of far) {
      const byJumps = searchPath(home, dest, 'jumps')!,
        byExotic = searchPath(home, dest, 'exotic')!,
        byTime = searchPath(home, dest, 'fastest')!;
      const exotic = (p: typeof byJumps) => hops(p).reduce((t, ly) => t + jumpCost(ly), 0);
      expect(byJumps.length).toBeLessThanOrEqual(byExotic.length);
      expect(byJumps.length).toBeLessThanOrEqual(byTime.length);
      expect(exotic(byExotic)).toBeLessThanOrEqual(exotic(byJumps) + 1e-9);
      expect(exotic(byExotic)).toBeLessThanOrEqual(exotic(byTime) + 1e-9);
      // can't do better than ⌈distance / range⌉ jumps
      expect(byJumps.length).toBeGreaterThanOrEqual(Math.ceil(dest.pos.length() / JUMP_RANGE));
    }
  });
});

/* ---------- routes to Lagrange points ---------- */
import { newShip, type Game } from '../Game';
import { updateBodies } from '../sim/kepler';
import { addNavResult, adjustNavRevs, parseLPoint, planRoute, searchNav, updateNav, type Route } from '../sim/navroute';
import { scanKey } from '../sim/scanner';
import type { CurrentSystem, Star, World } from '../types';
import { WT } from '../constants';
import { buildTrojans } from '../universe/trojans';
import { buildSystem, findHome, systemAnchor } from '../universe/system';
import { lpointFor } from '../sim/lpoints';

function lgame() {
  const sys = homeSystem();
  const bodies = buildSystem(sys);
  updateBodies(bodies, 1e6);
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  const cur: CurrentSystem = { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: false, stations: [], trojans: buildTrojans(sys, bodies).fields };
  const seen = new Set<string>();
  for (const b of bodies) if (b.kind === 'planet') seen.add(scanKey(sys, b));
  const sky = systemsNear(new THREE.Vector3(), 30);
  const msgs: string[] = [];
  const ship = newShip();
  ship.pos.set(1.4e11, 0, 0);
  ship.batt = 500;
  Object.assign(ship.avionics, {
    nav: { model: 'MNV-7000', name: 'x', caps: { crossSystem: true, maxHops: 12, refuelStops: true, optimise: true } },
    orbit: { model: 'HX-9100', name: 'x', caps: { types: ['equatorial', 'hold', 'lagrange'], preview: true, ftlLeg: true, readouts: true, profile: { acc: 40, radialCap: 7000, planeCap: 4000 } } },
  });
  const g = {
    cur,
    sky,
    ship,
    simTime: 1e6,
    radar: { seen },
    scans: new Map(),
    navPoints: [] as StarSystem[],
    navFinal: null as null | { kind: 'body' | 'station' | 'lpoint'; name: string; sysId: string },
    navQuery: '',
    navRevs: 3,
    navSortFrom: 'ship' as const,
    navMode: 'jumps' as const,
    navError: null as string | null,
    route: null as Route | null,
    target: null,
    frameBody: stars[0],
    planner: null,
    msg: { text: '', kind: '', on: false, t: 0 },
    showMsg: (t: string) => msgs.push(t),
    invalidateHud: () => {},
    warned: {},
  } as unknown as Game;
  return { g, cur, bodies, ship, msgs };
}
type StarSystem = ReturnType<typeof homeSystem>;

describe('routes to Lagrange points', () => {
  it('parses a point\'s name', () => {
    expect(parseLPoint('Venydes 2 L4')).toEqual({ planet: 'Venydes 2', k: 4 });
    expect(parseLPoint('Venydes 2')).toBeNull();
    expect(parseLPoint('Venydes L6')).toBeNull();
  });

  it('plot a leg to a targeted point: ~10 minutes for L1/L2, years for a phasing transfer to L4', () => {
    const { g, cur } = lgame();
    const w = findHome(cur.bodies) as World;
    for (const [k, min, max] of [[2, 100, 3600], [4, 4e7, 2e8]] as const) {
      (g as unknown as { target: unknown }).target = lpointFor(g, w, k);
      const r = planRoute(g, 'jumps') as Route;
      expect(typeof r).toBe('object');
      expect(r.legs).toHaveLength(1);
      const leg = r.legs[0];
      expect(leg.kind).toBe('lpoint');
      if (leg.kind === 'lpoint') {
        expect(leg.planet).toBe(w.name);
        expect(leg.k).toBe(k);
        expect(leg.time).toBeGreaterThan(min);
        expect(leg.time).toBeLessThan(max);
      }
      expect(r.destName).toBe(`${w.name} L${k} · ${cur.sys.name}`);
    }
  });

  it('are found by the search, here and in other systems, and added as the route\'s end', () => {
    const { g, cur } = lgame();
    const giant = cur.bodies.find((b): b is World => b.kind === 'planet' && b.type >= WT.GasGiant)!;
    const here = searchNav(g, `${giant.name} L`, 'ship');
    expect(here.filter((r) => r.kind === 'lpoint').map((r) => r.name)).toEqual(expect.arrayContaining([`${giant.name} L1`, `${giant.name} L5`]));
    // another system's planet, by the name of its system
    const other = g.sky.find((s) => s.id !== cur.sys.id && s.pos.distanceTo(cur.sys.pos) < 12)!;
    const op = buildSystem(other).find((b): b is World => b.kind === 'planet')!;
    const found = searchNav(g, `${op.name} L4`, 'ship').find((r) => r.kind === 'lpoint' && r.name === `${op.name} L4`);
    expect(found).toBeTruthy();
    expect(found!.sys.id).toBe(other.id);
    // adding it makes the system a waypoint and the point the final stop; the plan is jumps, then the point
    g.navQuery = `${op.name} L4`;
    addNavResult(g, found!.key);
    expect(g.navFinal).toEqual({ kind: 'lpoint', name: `${op.name} L4`, sysId: other.id });
    const r = g.route!;
    expect(r.legs[r.legs.length - 1].kind).toBe('lpoint');
    expect(r.legs.some((l) => l.kind === 'jump')).toBe(true);
    expect(r.destName).toContain(`${op.name} L4`);
  });

  it('are flown: the leg hands the ship to the autopilot as a hold at the point, a phasing transfer for L4', () => {
    const { g, cur, ship } = lgame();
    const w = findHome(cur.bodies) as World;
    (g as unknown as { target: unknown }).target = lpointFor(g, w, 4);
    const r = planRoute(g, 'jumps') as Route;
    r.running = true;
    g.route = r;
    updateNav(g, 0.016);
    expect(ship.ap?.type).toBe('lagrange');
    expect(ship.ap?.lk).toBe(4);
    expect(ship.ap?.body).toBe(w);
    expect(ship.ap?.revs).toBe(3);
    expect(ship.ap?.ph?.stage).toBe('depart');
    expect(r.status).toMatch(/L4/);
    expect(r.i).toBe(0); // (still on the leg: it ends when the hold is made)
  });

  it('take the orbit count from the nav panel: clamped, replanned, handed to the autopilot, locked while flying', () => {
    const { g, cur, ship } = lgame();
    const w = findHome(cur.bodies) as World;
    (g as unknown as { target: unknown }).target = lpointFor(g, w, 4);
    g.route = planRoute(g, 'jumps') as Route;
    const leg = () => g.route!.legs[g.route!.legs.length - 1] as { revs: number; time: number; dv: number | null };
    expect(leg().revs).toBe(3);
    const t3 = leg().time;
    adjustNavRevs(g, 2);
    expect(g.navRevs).toBe(5);
    expect(leg().revs).toBe(5);
    expect(leg().time).toBeGreaterThan(t3);
    adjustNavRevs(g, 1000);
    expect(g.navRevs).toBe(40);
    adjustNavRevs(g, -1000);
    expect(g.navRevs).toBe(0);
    expect(leg().revs).toBe(0);
    adjustNavRevs(g, 4);
    g.route!.running = true;
    adjustNavRevs(g, 3);
    expect(g.navRevs).toBe(4); // locked while the route is flying
    updateNav(g, 0.016);
    expect(ship.ap?.revs).toBe(4);
  });

  it('end the route cleanly where the unit can\'t hold at a point', () => {
    const { g, cur, ship, msgs } = lgame();
    const w = findHome(cur.bodies) as World;
    (ship.avionics.orbit!.caps.types as string[]).splice(0, 3, 'equatorial');
    (g as unknown as { target: unknown }).target = lpointFor(g, w, 1);
    const r = planRoute(g, 'jumps') as Route;
    r.running = true;
    g.route = r;
    updateNav(g, 0.016);
    expect(ship.ap).toBeNull();
    expect(msgs.join(' ')).toMatch(/orbit computer that holds at Lagrange points/);
  });
});
