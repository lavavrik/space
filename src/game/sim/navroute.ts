/*
 * Navigation computer (the fitted Meridian Systems unit): plot a route and fly it leg by leg.
 *
 * Destinations: a star system (any star you click within SKY_RADIUS while the nav panel is open),
 * or the current target (a body or station in this system).
 *
 * Planning: an A* search over the star graph, each system's neighbours being the systems within
 * JUMP_RANGE. Edge costs depend on the mode: fewest jumps, least exotic matter (2 + 0.02·ly² per
 * jump), or fastest (charge + transit + realigning). Heuristics are admissible lower bounds, so
 * routes are optimal for their mode. Then exotic matter is simulated along the route: units with
 * refuel stops insert a star-skimming stop where the tank would run short; others just warn.
 *
 * Flying: one leg at a time, reusing the existing systems: hyperjumps (waiting for the battery if
 * needed), an autopilot hold skimming a star's corona to refuel, and finally the autopilot's orbit
 * or station rendezvous. Disengaging the autopilot during a leg cancels the route.
 */
import { JUMP_CHARGE_TIME, JUMP_RANGE, JUMP_TUNNEL_BASE, JUMP_TUNNEL_PER_LY, SHIP, jumpCost } from '../constants';
import type { Game } from '../Game';
import type { StarSystem, Target } from '../types';
import { systemsNear } from '../universe/galaxy';
import { transitTime } from './hyperspace';
import { dropFTL } from './ftl';
import { startJump } from './navigation';
import { defaultOrbitAlt, evalPlan } from './orbits';
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
  | { kind: 'rendezvous'; station: string; time: number };

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
/** Rough time to skim a star from empty to full (corona scoop at ~0.6 kg/s of exotic matter). */
const REFUEL_TIME = SHIP.exoticCap / 0.6 + 60;
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
  const target: Target | null = destSys ? null : g.target;
  if (destSys) {
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
        if (nav.caps.refuelStops) {
          legs.push({ kind: 'refuel', at, time: REFUEL_TIME });
          ex = SHIP.exoticCap;
        } else if (!warning) warning = `Exotic matter runs out before ${to.name} · refuel on the way`;
      }
      legs.push({ kind: 'jump', to, ly, cost, time: hopTime(ly) });
      ex -= cost;
      at = to;
    }
    destName = `${destSys.name} · ${destSys.star.spec} · ${destSys.pos.distanceTo(g.cur.sys.pos).toFixed(1)} ly${points.length > 1 ? ` · via ${points.length - 1} waypoint${points.length > 2 ? 's' : ''}` : ''}`;
  } else if (target && target.kind === 'station') {
    legs.push({ kind: 'rendezvous', station: target.name, time: 150 });
    destName = `${target.name} · ${target.parent.name}`;
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

/** Add a star as the next waypoint (not the current system, nor a repeat of the last). */
export function addNavPoint(g: Game, s: StarSystem) {
  if (g.route?.running) return;
  const last = g.navPoints[g.navPoints.length - 1];
  if (s.id === g.cur.sys.id || s.id === last?.id) return;
  g.navPoints.push(s);
  replan(g);
  g.showMsg(`Waypoint ${g.navPoints.length} · ${s.name} · ${s.pos.distanceTo((last ?? g.cur.sys).pos).toFixed(1)} ly from ${last ? last.name : 'here'}`, 'ftl');
}

/** Remove the last waypoint (Backspace or the button in the nav panel). */
export function removeNavPoint(g: Game) {
  if (g.route?.running) return;
  const p = g.navPoints.pop();
  replan(g);
  if (p) g.showMsg(`Removed waypoint · ${p.name}`);
}

/**
 * Star search for the nav panel: systems in the sky whose names contain `query`, nearest first,
 * measured from the ship or from the last waypoint.
 */
export function searchStars(g: Game, query: string, from: 'ship' | 'last', limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const last = g.navPoints[g.navPoints.length - 1];
  const origin = from === 'last' && last ? last.pos : g.cur.sys.pos;
  return g.sky
    .filter((s) => s.id !== g.cur.sys.id && s.id !== last?.id && s.name.toLowerCase().includes(q))
    .map((s) => ({ s, d: s.pos.distanceTo(origin) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
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
        // hold one stellar radius above the photosphere, inside the corona where the scoop works
        const u = ship.pos.clone().sub(star.pos).normalize();
        engageAutopilot(g, { body: star, type: 'hold', r0: star.radius * 2, period: NaN, n: null, point: u.multiplyScalar(star.radius * 2), station: null }, true);
        r.legStarted = true;
        ship.sunTrack = true; // recharge the battery for the jumps ahead while skimming
      }
      if (!ship.ap) return endRoute(g, 'Route cancelled · autopilot disengaged', 'warn');
      r.status = ship.ap.settled ? `skimming the corona · ${ship.exotic.toFixed(0)} / ${SHIP.exoticCap} kg exotic` : 'flying to the corona';
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
  g.route!.status = `waiting · charging the battery (${ship.batt.toFixed(0)} / ${LEG_BATTERY} kWh)`;
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
