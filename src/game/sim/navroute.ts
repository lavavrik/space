/*
 * Navigation computer (the fitted Meridian Systems unit): plot a route and fly it leg by leg.
 *
 * Destinations: a star system (any star you click within SKY_RADIUS while the nav panel is open),
 * or the current target (a body, a station or a Lagrange point in this system).
 *
 * Planning: an A* search over the star graph, each system's neighbours being the systems within
 * JUMP_RANGE. Edge costs depend on the mode: fewest jumps, least exotic matter (2 + 0.02·ly² per
 * jump), or fastest (charge + transit + realigning). Heuristics are admissible lower bounds, so
 * routes are optimal for their mode. Then exotic matter is simulated along the route: units with
 * refuel stops insert a star-skimming stop where the tank would run short; others just warn.
 *
 * Flying: one leg at a time, reusing the existing systems: hyperjumps (waiting for the battery if
 * needed), an autopilot hold skimming a star's corona to refuel, and finally the autopilot's orbit
 * or station rendezvous, or a hold at a Lagrange point (a phasing transfer for L3–L5: docs/lagrange.md).
 * Disengaging the autopilot during a leg cancels the route.
 */
import { pairSpec } from '../universe/binary';
import { JUMP_CHARGE_TIME, JUMP_RANGE, JUMP_TUNNEL_BASE, JUMP_TUNNEL_PER_LY, LY, SCOOP_FLUX_FULL, SHIP, fluxDist, jumpCost } from '../constants';
import { THREE } from '../lib/three';
import { scoopFitted } from '../outfit/catalog';
import { contactLabel, radarSeen } from './radar';
import { fmtDist, fmtEnergy, fmtTime } from '../format';
import type { Game } from '../Game';
import type { Planner, StarSystem, Target, World } from '../types';
import { systemsNear } from '../universe/galaxy';
import { buildStations } from '../universe/stations';
import { buildSystem } from '../universe/system';
import { transitTime } from './hyperspace';
import { dropAlt, dropFTL, massLock } from './ftl';
import { galPos, jumpBlocker, startJump } from './navigation';
import { defaultOrbitAlt, evalPlan } from './orbits';
import { lpointsHere } from './lpoints';
import { phasingEstimate } from './phasing';
import { phasingReaches } from './lagrange';
import { disengageAP, engageAutopilot, engageRendezvous } from './planner';

export type NavMode = 'jumps' | 'exotic' | 'fastest';
export const NAV_MODES: { id: NavMode; label: string }[] = [
  { id: 'jumps', label: 'Fewest jumps' },
  { id: 'exotic', label: 'Least exotic' },
  { id: 'fastest', label: 'Fastest' },
];

export type Leg =
  | { kind: 'jump'; to: StarSystem; ly: number; cost: number; time: number }
  | { kind: 'refuel'; at: StarSystem; time: number }
  | { kind: 'orbit'; body: string; time: number }
  | { kind: 'rendezvous'; station: string; time: number }
  | { kind: 'lpoint'; planet: string; k: 1 | 2 | 3 | 4 | 5; sysId: string; time: number; revs: number; dv: number | null };

export interface Route {
  destName: string;
  mode: NavMode;
  legs: Leg[];
  warning: string | null;
  exoticNeeded: number; // kg over the whole route (before any refuel)
  running: boolean;
  i: number; // current leg
  legStarted: boolean;
  retry: number; // s until the next attempt to start a jump
  status: string; // what the current leg is doing / waiting for
}

/** Seconds a hyperjump takes door to door: charge, transit, and realigning afterwards. */
const hopTime = (ly: number) => JUMP_CHARGE_TIME + transitTime(ly) + 20;
/** Rough time to skim a star from empty to full (corona scoop at its full 1.2 kg/s, plus getting there). */
const REFUEL_TIME = SHIP.exoticCap / 1.2 + 90;
/** While skimming, the nose points at the star tipped this far (rad) so the panels on top still catch light. */
const SKIM_TILT = 0.17;
/** Keep this much exotic matter spare on every hop. */
const EXOTIC_MARGIN = 1;
const MAX_EXPANSIONS = 6000;

/* ---------- planning ---------- */

function edgeCost(mode: NavMode, ly: number) {
  return mode === 'jumps' ? 1 : mode === 'exotic' ? jumpCost(ly) : hopTime(ly);
}

/** Admissible lower bound on the cost to cover `D` ly: at least ⌈D/R⌉ hops, cheapest when equal. */
function heuristic(mode: NavMode, D: number) {
  if (D <= 0) return 0;
  const n = Math.ceil(D / JUMP_RANGE);
  if (mode === 'jumps') return n;
  if (mode === 'exotic') return n * (2 + 0.02 * (D / n) ** 2);
  return n * (JUMP_CHARGE_TIME + JUMP_TUNNEL_BASE + 20) + JUMP_TUNNEL_PER_LY * D;
}

/** A* over the star graph. Returns the systems after `from`, ending at `to`, or null. */
export function searchPath(from: StarSystem, to: StarSystem, mode: NavMode): StarSystem[] | null {
  const open = new MinHeap<{ s: StarSystem; f: number }>((a, b) => a.f - b.f);
  const gCost = new Map<string, number>([[from.id, 0]]);
  const prev = new Map<string, StarSystem>();
  open.push({ s: from, f: heuristic(mode, from.pos.distanceTo(to.pos)) });
  const closed = new Set<string>();
  let expansions = 0;
  while (open.size) {
    const { s } = open.pop()!;
    if (closed.has(s.id)) continue;
    if (s.id === to.id) {
      const path: StarSystem[] = [];
      for (let c: StarSystem | undefined = s; c && c.id !== from.id; c = prev.get(c.id)) path.unshift(c);
      return path;
    }
    closed.add(s.id);
    if (++expansions > MAX_EXPANSIONS) return null;
    const gs = gCost.get(s.id)!;
    for (const n of systemsNear(s.pos, JUMP_RANGE)) {
      if (n.id === s.id || closed.has(n.id)) continue;
      const cand = gs + edgeCost(mode, n.pos.distanceTo(s.pos));
      if (cand < (gCost.get(n.id) ?? Infinity)) {
        gCost.set(n.id, cand);
        prev.set(n.id, s);
        open.push({ s: n, f: cand + heuristic(mode, n.pos.distanceTo(to.pos)) });
      }
    }
  }
  return null;
}

/**
 * Plot a route through the nav waypoints (stars, in order; each stretch searched separately and
 * optimal for the mode), or, with no waypoints, to the current target in this system. Or say why not.
 */
export function planRoute(g: Game, mode: NavMode): Route | string {
  const nav = g.ship.avionics.nav;
  if (!nav) return 'No navigation computer fitted';
  const legs: Leg[] = [];
  let warning: string | null = null,
    exoticNeeded = 0,
    destName: string;
  const points = g.navPoints;
  const destSys = points[points.length - 1] ?? null;
  const fin = g.navFinal;
  const target: Target | null = destSys || fin ? null : g.target;
  if (!destSys && fin) {
    // a body or station in this system: just the final leg
    legs.push(finalLeg(g, fin));
    destName = `${fin.name} · ${g.cur.sys.name}`;
  } else if (destSys) {
    if (!nav.caps.crossSystem) return `${nav.model} plots in-system routes only`;
    // chain the stretches between waypoints; over the unit's hop limit, fewest jumps is the best it can do
    const chain = (m: NavMode) => {
      const all: StarSystem[] = [];
      let from = g.cur.sys;
      for (const p of points) {
        if (p.id === from.id) continue;
        const seg = searchPath(from, p, m);
        if (!seg) return { path: null, stuck: p };
        all.push(...seg);
        from = p;
      }
      return { path: all, stuck: null };
    };
    let { path, stuck } = chain(mode);
    if (path && path.length > nav.caps.maxHops && mode !== 'jumps') ({ path, stuck } = chain('jumps'));
    if (!path) return `No route to ${stuck!.name} found`;
    if (path.length > nav.caps.maxHops) return `That's ${path.length} jumps · ${nav.model} plots up to ${nav.caps.maxHops}`;
    let ex = g.ship.exotic,
      at = g.cur.sys;
    for (const to of path) {
      const ly = to.pos.distanceTo(at.pos),
        cost = jumpCost(ly);
      exoticNeeded += cost;
      if (ex < cost + EXOTIC_MARGIN) {
        if (nav.caps.refuelStops && scoopFitted(g.ship.outfit)?.caps.exotic) {
          legs.push({ kind: 'refuel', at, time: REFUEL_TIME });
          ex = SHIP.exoticCap;
        } else if (!warning)
          warning = nav.caps.refuelStops ? `Exotic matter runs out before ${to.name} · refuel stops need a corona scoop (FS-3 or FS-5)` : `Exotic matter runs out before ${to.name} · refuel on the way`;
      }
      legs.push({ kind: 'jump', to, ly, cost, time: hopTime(ly) });
      ex -= cost;
      at = to;
    }
    const via = points.length > 1 ? ` · via ${points.length - 1} waypoint${points.length > 2 ? 's' : ''}` : '';
    destName = `${destSys.name} · ${pairSpec(destSys)} · ${destSys.pos.distanceTo(g.cur.sys.pos).toFixed(1)} ly${via}`;
    // ending at a body or station there: orbit it or rendezvous with it after the last jump
    if (fin && fin.sysId === destSys.id) {
      legs.push(finalLeg(g, fin));
      destName = `${fin.name} · ${destSys.name} · ${destSys.pos.distanceTo(g.cur.sys.pos).toFixed(1)} ly${via}`;
    }
  } else if (target && target.kind === 'station') {
    legs.push({ kind: 'rendezvous', station: target.name, time: 150 });
    destName = `${target.name} · ${target.parent.name}`;
  } else if (target && target.kind === 'lpoint') {
    legs.push(lpointLeg(g, g.cur.sys.id, target.name));
    destName = `${target.name} · ${g.cur.sys.name}`;
  } else if (target && target.kind !== 'star') {
    legs.push({ kind: 'orbit', body: target.name, time: 180 });
    destName = target.name;
  } else {
    return 'Pick a destination: click or search for a star, or target a body or station';
  }
  return { destName, mode, legs, warning, exoticNeeded, running: false, i: 0, legStarted: false, retry: 0, status: '' };
}

/** (Re)plot the route for the nav panel, unless one is being flown. */
export function replan(g: Game) {
  if (g.route?.running) return;
  const r = planRoute(g, g.navMode);
  g.route = typeof r === 'string' ? null : r;
  g.navError = typeof r === 'string' ? r : null;
  g.invalidateHud();
}

/** Where a route may end besides a star: a body (orbit it) or a station (rendezvous), by name. */
export interface NavFinal {
  kind: 'body' | 'station' | 'lpoint';
  /** A body's or station's name; for a Lagrange point, "Venydes 2 L4". */
  name: string;
  sysId: string;
}

/** "Venydes 2 L4" → its planet's name and the point (null if it isn't one). */
export function parseLPoint(name: string): { planet: string; k: 1 | 2 | 3 | 4 | 5 } | null {
  const m = /^(.*) L([1-5])$/.exec(name);
  return m ? { planet: m[1], k: Number(m[2]) as 1 | 2 | 3 | 4 | 5 } : null;
}

/** Orbits a route's phasing transfer to L3–L5 takes unless the nav panel sets it (the planner's default; L1 and L2 are flown to straight). 0 is straight there. */
export const ROUTE_REVS = 3;
export const ROUTE_REVS_MAX = 40;

/** Step the orbits of the route's phasing transfer (the nav panel's stepper, [ and ]; `step` is ±1, ±5 with Shift), and re-plot. */
export function adjustNavRevs(g: Game, step: number) {
  if (g.route?.running) return;
  g.navRevs = Math.min(ROUTE_REVS_MAX, Math.max(0, g.navRevs + step));
  replan(g);
}

/**
 * The leg to a Lagrange point: how long it takes is the FTL leg and the match (~10 minutes) plus, for
 * L3–L5, the phasing transfer's flight (sim/phasing.ts) for the orbits the panel has set
 * (`Game.navRevs`), worked out from the planet where it's in this system or can be built, and its Δv.
 */
function lpointLeg(g: Game, sysId: string, name: string): Leg {
  const p = parseLPoint(name)!;
  let time = 600;
  let revs = p.k >= 3 ? g.navRevs : 0;
  let dv: number | null = null;
  if (p.k >= 3) {
    // (the point's world: a planet, or a moon, whose points are round its planet)
    const sys = g.cur.sys.id === sysId ? g.cur.sys : g.sky.find((s) => s.id === sysId);
    const isWorld = (b: { name: string; kind: string }) => b.name === p.planet && (b.kind === 'planet' || b.kind === 'moon');
    const w = g.cur.sys.id === sysId ? (g.cur.bodies.find(isWorld) as World | undefined) : sys ? (buildSystem(sys).find(isWorld) as World | undefined) : undefined;
    if (w && !phasingReaches(w, p.k)) revs = 0; // (a heavy moon's L4 and L5: straight there)
    if (w && revs > 0) {
      const est = phasingEstimate(w, p.k as 3 | 4 | 5, revs);
      time += est.T;
      dv = est.dv;
    } else if (!w) time += revs * 3.2e7;
  }
  return { kind: 'lpoint', planet: p.planet, k: p.k, sysId, time, revs, dv };
}

const finalLeg = (g: Game, f: NavFinal): Leg => (f.kind === 'station' ? { kind: 'rendezvous', station: f.name, time: 150 } : f.kind === 'lpoint' ? lpointLeg(g, f.sysId, f.name) : { kind: 'orbit', body: f.name, time: 180 });

/** Add a star as the next waypoint (not the current system, nor a repeat of the last). */
export function addNavPoint(g: Game, s: StarSystem) {
  if (g.route?.running) return;
  const last = g.navPoints[g.navPoints.length - 1];
  if (s.id === g.cur.sys.id || s.id === last?.id) return;
  g.navPoints.push(s);
  g.navFinal = null; // a body can only be the last stop
  replan(g);
  g.showMsg(`Waypoint ${g.navPoints.length} · ${s.name} · ${s.pos.distanceTo((last ?? g.cur.sys).pos).toFixed(1)} ly from ${last ? last.name : 'here'}`, 'ftl');
}

/** End the route at a body or station (in its system; that system becomes the last waypoint). */
export function addNavFinal(g: Game, sys: StarSystem, kind: NavFinal['kind'], name: string) {
  if (g.route?.running) return;
  const last = g.navPoints[g.navPoints.length - 1];
  if (sys.id !== g.cur.sys.id && sys.id !== last?.id) g.navPoints.push(sys);
  else if (sys.id === g.cur.sys.id && last) g.navPoints = []; // back here: just the in-system leg
  g.navFinal = { kind, name, sysId: sys.id };
  replan(g);
  g.showMsg(`Route ends at ${name} · ${sys.name}`, 'ftl');
}

/** Remove the last stop (Backspace or the button): the final body first, then waypoints. */
export function removeNavPoint(g: Game) {
  if (g.route?.running) return;
  if (g.navFinal) {
    const f = g.navFinal;
    g.navFinal = null;
    replan(g);
    return g.showMsg(`Removed ${f.name}`);
  }
  const p = g.navPoints.pop();
  replan(g);
  if (p) g.showMsg(`Removed waypoint · ${p.name}`);
}

/** A nav search hit: a star, or a planet, moon or station (in this system or a nearby one). */
export interface NavResult {
  key: string;
  /** 'star': another system (a waypoint); 'sun': a star here, a wide pair's (docs/binaries.md). */
  kind: 'star' | 'sun' | 'planet' | 'moon' | 'station' | 'lpoint';
  name: string; // as shown (may be "Unidentified …" until scanned)
  /** The object's real name, for routing (system ids contain colons, so it can't come from the key). */
  real?: string;
  detail: string;
  sys: StarSystem;
  dist: number; // ly from the sort origin (bodies in this system: their distance in ly, ~0)
}

const contents = new Map<string, { bodies: { name: string; kind: 'planet' | 'moon'; type: string }[]; stations: string[] }>();
/** Planets, moons and stations of another system, generated on demand (cheap: ~0.05 ms) and cached (this system's come from the live scene). */
function systemContents(sys: StarSystem) {
  let c = contents.get(sys.id);
  if (!c) {
    if (contents.size > 400) contents.clear();
    const bodies = buildSystem(sys);
    c = {
      bodies: bodies.filter((b) => b.kind !== 'star').map((b) => ({ name: b.name, kind: b.kind as 'planet' | 'moon', type: b.typeName })),
      stations: buildStations(sys, bodies).map((s) => s.name),
    };
    contents.set(sys.id, c);
  }
  return c;
}

/** Distance to something in this system, for the dropdown: under 1 km it just says so. */
function fmtNear(m: number) {
  if (m < 1000) return '<1 km';
  if (m < 1e4) return `${(m / 1000).toFixed(1)} km`;
  return fmtDist(m);
}

/**
 * Nav search: stars in the sky whose names contain the query, plus planets, moons and stations in
 * this system, in systems within jump range, and in any system whose name the query names (so
 * "sylios 2" finds Sylios 2 and its moons). Nearest first, from the ship or the last waypoint.
 * With no query it lists what's nearest: this system's bodies and stations, then the closest stars.
 * Things in this system show their actual distance from the ship (to the surface, or the hull).
 */
export function searchNav(g: Game, query: string, from: 'ship' | 'last', limit = 12): NavResult[] {
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const last = g.navPoints[g.navPoints.length - 1];
  const fromLast = from === 'last' && !!last;
  const origin = fromLast ? last.pos : g.cur.sys.pos;
  const out: NavResult[] = [];
  const ly = (s: StarSystem) => s.pos.distanceTo(origin);

  // this system: only what the radar has detected (sim/radar.ts), under its name once scanned,
  // else as an unidentified class; live positions, real distances
  const here = g.cur.sys;
  const hereDetail = (m: number) => (fromLast ? `here · ${ly(here).toFixed(1)} ly from ${last.name}` : fmtNear(m));
  const hereKey = (m: number) => (fromLast ? ly(here) : m / LY);
  // (a wide pair's stars are destinations too, tens to hundreds of AU apart; a lone star or a close
  // pair's aren't: you arrive beside them)
  const suns = g.cur.stars.length > 1 && !g.cur.close;
  for (const b of g.cur.bodies) {
    if (b.kind === 'star' ? !suns : !radarSeen(g, b)) continue; // (a star is always in view)
    const label = contactLabel(g, b),
      known = label === b.name;
    if (!match(label)) continue;
    const m = Math.max(0, b.pos.distanceTo(g.ship.pos) - b.radius);
    out.push({ key: `${b.kind}:${here.id}:${b.name}`, kind: b.kind === 'star' ? 'sun' : b.kind, name: label, real: b.name, detail: `${known ? b.typeName : 'radar contact'} · ${hereDetail(m)}`, sys: here, dist: hereKey(m) });
  }
  for (const st of g.cur.stations) {
    if (!radarSeen(g, st)) continue;
    const label = contactLabel(g, st);
    if (!match(label)) continue;
    const m = Math.max(0, st.pos.distanceTo(g.ship.pos) - st.size / 2);
    out.push({ key: `station:${here.id}:${st.name}`, kind: 'station', name: label, real: st.name, detail: `${label === st.name ? `station · ${st.parent.name}` : 'radar contact'} · ${hereDetail(m)}`, sys: here, dist: hereKey(m) });
  }

  // this system's Lagrange points, of the planets the radar has found (as a target does: sim/lpoints.ts)
  if (q) {
    for (const t of lpointsHere(g)) {
      if (!match(t.name)) continue;
      const m = Math.max(0, t.pos.distanceTo(g.ship.pos));
      out.push({ key: `lpoint:${here.id}:${t.name}`, kind: 'lpoint', name: t.name, real: t.name, detail: `${t.k >= 4 ? 'stable' : 'unstable'} Lagrange point · ${hereDetail(m)}`, sys: here, dist: hereKey(m) });
    }
  }

  // stars
  for (const s of g.sky) {
    if (s.id !== here.id && s.id !== last?.id && match(s.name)) out.push({ key: `star:${s.id}`, kind: 'star', name: s.name, detail: `${pairSpec(s)}${s.companion ? ' pair' : ' star'} · ${ly(s).toFixed(1)} ly`, sys: s, dist: ly(s) });
  }

  // bodies and stations of other systems: those within jump range, the last stop, and any the query names
  if (q) {
    const others = g.sky.filter((s) => s.id !== here.id && (s.pos.distanceTo(here.pos) <= JUMP_RANGE || s.id === last?.id || q.startsWith(s.name.toLowerCase()) || s.name.toLowerCase().startsWith(q)));
    for (const s of others) {
      const c = systemContents(s);
      const where = `${s.name} · ${ly(s).toFixed(1)} ly`;
      for (const b of c.bodies) if (match(b.name)) out.push({ key: `${b.kind}:${s.id}:${b.name}`, kind: b.kind, name: b.name, detail: `${b.type} · ${where}`, sys: s, dist: ly(s) });
      for (const n of c.stations) if (match(n)) out.push({ key: `station:${s.id}:${n}`, kind: 'station', name: n, detail: `station · ${where}`, sys: s, dist: ly(s) });
      // a planet's five Lagrange points (the planet's name and L1…L5), once the query names one
      for (const b of c.bodies) if (b.kind === 'planet' || b.kind === 'moon') for (const k of [1, 2, 3, 4, 5]) if (match(`${b.name} L${k}`)) out.push({ key: `lpoint:${s.id}:${b.name} L${k}`, kind: 'lpoint', name: `${b.name} L${k}`, detail: `${k >= 4 ? 'stable' : 'unstable'} Lagrange point · ${where}`, sys: s, dist: ly(s) });
    }
  }
  return out.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Add a search hit to the route: a star as a waypoint, a body or station as the final stop. */
export function addNavResult(g: Game, key: string) {
  const r = searchNav(g, g.navQuery, g.navSortFrom, 200).find((x) => x.key === key);
  if (!r) return;
  if (r.kind === 'star') addNavPoint(g, r.sys);
  // route by the real name (the shown one may be "Unidentified …" until it's scanned)
  else addNavFinal(g, r.sys, r.kind === 'station' ? 'station' : r.kind === 'lpoint' ? 'lpoint' : 'body', r.real ?? r.name);
}

/* ---------- flying ---------- */

export function engageRoute(g: Game) {
  const r = g.route;
  if (!r || r.running) return;
  if (!r.legs.length) return g.showMsg('Already there', 'warn');
  r.running = true;
  r.i = 0;
  r.legStarted = false;
  g.navConfirm = 0;
  g.showMsg(`Route engaged · ${r.destName}`, 'ftl');
}

/** Backspace (twice) or the button: cancel a route being flown; the first press arms it. */
export function requestCancelRoute(g: Game) {
  const r = g.route;
  if (!r?.running) return;
  if (g.navConfirm > 0) {
    endRoute(g, 'Route cancelled');
    if (g.ship.ap) disengageAP(g);
    return;
  }
  g.navConfirm = 3;
  g.showMsg('Cancel the route? Backspace again to confirm', 'warn');
}

function endRoute(g: Game, msg: string, kind: '' | 'ftl' | 'warn' = '') {
  g.route = null;
  g.navConfirm = 0;
  g.navPoints = [];
  g.navFinal = null;
  g.showMsg(msg, kind);
  g.invalidateHud();
}

function nextLeg(g: Game) {
  const r = g.route!;
  r.i++;
  r.legStarted = false;
  r.retry = 0;
  r.status = '';
  if (r.i >= r.legs.length) endRoute(g, `Route complete · ${r.destName}`, 'ftl');
  g.invalidateHud();
}

export function updateNav(g: Game, dt: number) {
  if (g.navConfirm > 0) g.navConfirm = Math.max(0, g.navConfirm - dt);
  const r = g.route;
  if (!r?.running || g.ship.dead) return;
  const { ship } = g;
  const leg = r.legs[r.i];
  switch (leg.kind) {
    case 'jump': {
      if (g.cur.sys.id === leg.to.id) {
        if (!g.jump) nextLeg(g);
        return;
      }
      if (g.jump) {
        r.status = g.jump.phase === 'charge' ? 'charging hyperdrive' : 'in hyperspace';
        return;
      }
      // too close to a world to jump (e.g. alongside a station): climb clear of its mass lock first
      const lock = massLock(g);
      if (lock) {
        if (ship.ap?.body !== lock || ship.ap.type !== 'hold') {
          const r0 = lock.radius + dropAlt(lock) * 1.35;
          const u = ship.pos.clone().sub(lock.pos).normalize();
          engageAutopilot(g, { body: lock, type: 'hold', r0, period: NaN, n: null, point: u.multiplyScalar(r0), station: null }, true);
        }
        r.status = `climbing clear of ${lock.name} to jump`;
        return;
      }
      // the destination is behind a body (often the star, after refuelling): move round to a side
      // where the straight departure line is clear, at the same distance from it
      const block = jumpBlocker(g, leg.to);
      if (block) {
        if (ship.ap?.body !== block || ship.ap.type !== 'hold') {
          const dir = leg.to.pos.clone().sub(galPos(g)).normalize();
          const off = ship.pos.clone().sub(block.pos);
          const r0 = Math.max(off.length(), block.radius * 1.3);
          const side = off.addScaledVector(dir, -off.dot(dir));
          if (side.lengthSq() < 1) side.set(dir.y, -dir.x, 0); // dead behind: any perpendicular
          engageAutopilot(g, { body: block, type: 'hold', r0, period: NaN, n: null, point: side.normalize().multiplyScalar(r0), station: null }, true);
        }
        r.status = `moving clear of ${block.name} to jump`;
        return;
      }
      ship.sunTrack = true; // between jumps, keep the panels on the star so the battery recharges
      // an idle FTL drive draws 600 kW (and exotic matter): drop out while waiting to jump
      if (ship.mode === 'ftl' && !ship.ap) dropFTL(g, false);
      if ((r.retry -= dt) > 0) return;
      r.retry = 2;
      if (ship.ap) disengageAP(g); // e.g. the refuelling hold before this jump
      g.jumpDest = leg.to;
      startJump(g);
      if (!g.jump) {
        // couldn't start (battery, mass lock…): turn the panels to the star and try again shortly
        r.status = `waiting · ${g.msg.text}`;
        ship.sunTrack = true;
      } else ship.sunTrack = false; // the charge swings the nose onto the destination
      return;
    }
    case 'refuel': {
      const star = g.cur.star;
      if (!r.legStarted) {
        // hold where the scoop reaches its full rate (starlight 100× Earth's, see docs/thermal.md)
        const r0 = fluxDist(star.L, SCOOP_FLUX_FULL, star.radius);
        const u = ship.pos.clone().sub(star.pos).normalize();
        engageAutopilot(g, { body: star, type: 'hold', r0, period: NaN, n: null, point: u.multiplyScalar(r0), station: null }, true);
        r.legStarted = true;
      }
      // Nose on the star: the hull shows it 113 m² instead of 720 side-on, so it settles near 450 K
      // instead of ~700 (which would lock the drives out). Tipped SKIM_TILT so the panels on top get
      // sin(10°) of 100× Earth's light, still more than the bus can take.
      ship.sunTrack = false;
      const m = new THREE.Matrix4().lookAt(ship.pos, star.pos, new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q));
      const aim = new THREE.Quaternion().setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -SKIM_TILT));
      ship.q.slerp(aim, Math.min(1, dt)).normalize();
      if (!ship.ap) return endRoute(g, 'Route cancelled · autopilot disengaged', 'warn');
      r.status = ship.scoop ? `skimming the corona · ${ship.exotic.toFixed(0)} / ${SHIP.exoticCap} kg exotic` : 'flying to the corona';
      if (ship.exotic >= SHIP.exoticCap - 0.5 && ship.prop >= SHIP.propCap * 0.98) {
        disengageAP(g);
        nextLeg(g);
      }
      return;
    }
    case 'orbit': {
      const b = g.cur.bodies.find((x) => x.name === leg.body);
      if (!b) return endRoute(g, `Route cancelled · ${leg.body} not found`, 'warn');
      if (!r.legStarted && waitForBattery(g)) return;
      if (!r.legStarted) {
        const oc = ship.avionics.orbit;
        if (!oc) return endRoute(g, 'Route needs an orbit computer', 'warn');
        const type = oc.caps.types.includes('equatorial') ? 'equatorial' : oc.caps.types[0];
        const u = ship.pos.clone().sub(b.pos).normalize();
        const ev = evalPlan({ body: b, type, alt: defaultOrbitAlt(b), dir: 1, curAlt: 0 }, ship);
        const n = type === 'hold' ? null : b.axis.clone();
        engageAutopilot(g, { body: b, type, r0: ev.r0, period: ev.period, n, point: type === 'hold' ? u.multiplyScalar(ev.r0) : null, station: null }, true);
        r.legStarted = true;
      }
      if (!ship.ap) return endRoute(g, 'Route cancelled · autopilot disengaged', 'warn');
      r.status = ship.ap.settled ? 'in orbit' : 'flying to orbit';
      if (ship.ap.settled) nextLeg(g); // the autopilot keeps flying the orbit
      return;
    }
    case 'lpoint': {
      const w = g.cur.bodies.find((x): x is World => (x.kind === 'planet' || x.kind === 'moon') && x.name === leg.planet);
      const name = `${leg.planet} L${leg.k}`;
      if (!w) return endRoute(g, `Route cancelled · ${leg.planet} not found`, 'warn');
      if (!r.legStarted && waitForBattery(g)) return;
      if (!r.legStarted) {
        // hold at the point: straight there for L1 and L2, a phasing transfer for L3–L5 (sim/phasing.ts)
        const oc = ship.avionics.orbit;
        if (!oc?.caps.types.includes('lagrange')) return endRoute(g, 'Route needs an orbit computer that holds at Lagrange points (HX-8200 or better)', 'warn');
        const revs = leg.revs;
        const plan: Planner = { body: w, type: 'lagrange', alt: 0, dir: 1, curAlt: 0, lk: leg.k, revs };
        const ev = evalPlan(plan, ship);
        if (!ev.ok) return endRoute(g, `Route cancelled · ${ev.note}`, 'warn');
        engageAutopilot(g, { body: w, type: 'lagrange', lk: leg.k, revs, r0: ev.r0, period: ev.period, n: null, point: null, station: null }, true);
        r.legStarted = true;
      }
      if (!ship.ap) return endRoute(g, 'Route cancelled · autopilot disengaged', 'warn');
      const ph = ship.ap.ph;
      r.status = ship.ap.settled
        ? `holding at ${name}`
        : ph
          ? { depart: `flying to the departure point for ${name}`, burn: `phasing burn for ${name}`, coast: `coasting to ${name} · ${fmtTime(Math.max(0, ph.tArr - g.simTime))} to go · time warp works`, arrive: `matching ${name}` }[ph.stage]
          : `flying to ${name}`;
      if (ship.ap.settled) nextLeg(g); // the autopilot keeps holding it
      return;
    }
    case 'rendezvous': {
      const st = g.cur.stations.find((x) => x.name === leg.station);
      if (!st) return endRoute(g, `Route cancelled · ${leg.station} not found`, 'warn');
      if (!r.legStarted && waitForBattery(g)) return;
      if (!r.legStarted) {
        engageRendezvous(g, st);
        r.legStarted = true;
      }
      if (!ship.ap) return endRoute(g, 'Route cancelled · autopilot disengaged', 'warn');
      r.status = ship.ap.settled ? 'alongside' : `closing · ${(st.pos.distanceTo(ship.pos) / 1e3).toFixed(0)} km`;
      if (ship.ap.settled) nextLeg(g);
      return;
    }
  }
}

/** Charge needed before handing a leg to the autopilot: its FTL leg draws ~6 MW to start, 600 kW to run. */
const LEG_BATTERY = 30; // kWh

/**
 * Before an autopilot leg, make sure the battery can carry its FTL leg (after a long route it's
 * often nearly flat, and a power failure mid-leg would drop the autopilot and the route): wait out
 * of FTL with the panels on the star. True while waiting.
 */
function waitForBattery(g: Game) {
  const { ship } = g;
  if (ship.batt >= LEG_BATTERY) return false;
  if (ship.mode === 'ftl' && !ship.ap) dropFTL(g, false);
  ship.sunTrack = true;
  g.route!.status = `waiting · charging the battery (${fmtEnergy(ship.batt)} / ${fmtEnergy(LEG_BATTERY)})`;
  return true;
}

/**
 * Nav panel open: the star in the sky (within SKY_RADIUS) nearest a click, as the route's
 * destination. `missPx` gives a star's on-screen distance from the click (Infinity if behind).
 */
export function pickNavStar(g: Game, missPx: (s: StarSystem) => number) {
  let best: StarSystem | null = null,
    bestMiss = 14;
  for (const s of g.sky) {
    if (s.id === g.cur.sys.id) continue;
    const miss = missPx(s);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = s;
    }
  }
  return best;
}

/* ---------- a small binary heap for A* ---------- */

class MinHeap<T> {
  private a: T[] = [];
  constructor(private readonly less: (x: T, y: T) => number) {}
  get size() {
    return this.a.length;
  }
  push(x: T) {
    const a = this.a;
    a.push(x);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0],
      last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
