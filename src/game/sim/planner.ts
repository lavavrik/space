/* Orbit planner (O): pick an orbit around a body and hand it to the autopilot. */
import { unitLabel } from '../avionics/catalog';
import { AP_FTL_MIN, FTL_CHARGE_TIME } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Autopilot, Body, OrbitType, Station, World } from '../types';
import { lagrangePoints } from './lagrange';
import { orbitBody } from './stationGeom';
import { ringDensity } from './rings';
import { apDistance, holdPoint } from './autopilot';
import { beltLock, ftlBlocked, massLock } from './ftl';
import { dominantBody } from './gravity';
import { startOrbitGuide } from './guide';
import { apLabel, defaultOrbitAlt, evalPlan, maxOrbitR, minOrbitAlt, orbitNormal } from './orbits';

const ORBIT_TYPE_NAMES: Record<OrbitType, string> = { equatorial: 'equatorial', polar: 'polar', sync: 'stationary', hold: 'hold-position', ring: 'ring', lagrange: 'Lagrange' };

export function openPlanner(g: Game) {
  const { ship } = g;
  const oc = ship.avionics.orbit;
  if (!oc) {
    g.showMsg('No orbit computer fitted · see avionics (U)', 'warn');
    return;
  }
  // a targeted station plans an orbit around the world it circles
  // (a ship has no orbit to plan round: plan round what you're near)
  const t = g.target && g.target.kind === 'station' ? g.target.parent : g.target && g.target.kind !== 'ship' && g.target.kind !== 'wreck' ? g.target : null;
  const b = t || (ship.grav && ship.grav.body) || dominantBody(g.cur, ship.pos);
  const curAlt = ship.pos.distanceTo(b.pos) - b.radius;
  g.planner = { body: b, type: oc.caps.types[0], alt: defaultOrbitAlt(b), dir: 1, curAlt, lk: 1 };
  g.invalidateHud();
}

export function closePlanner(g: Game) {
  g.planner = null;
  g.invalidateHud();
}

export function adjustAlt(g: Game, f: number) {
  const p = g.planner;
  if (!p) return;
  if (p.type === 'lagrange') {
    // ([ ] sets the orbits of the phasing transfer to L3–L5: 0 is straight there, more is cheaper and slower)
    // (Shift: five at a time; up to 40 orbits, the low-energy end where the cost has all but gone)
    if ((p.lk ?? 1) >= 3) p.revs = Math.min(40, Math.max(0, (p.revs ?? 3) + (Math.abs(Math.log(f)) > 0.3 ? 5 : 1) * (f > 1 ? 1 : -1)));
    g.invalidateHud();
    return;
  }
  if (p.type === 'sync') return;
  const b = p.body;
  if (p.type === 'ring' && b.kind !== 'star' && b.ring) {
    // across the ring in steps of 1 % of its width (Shift: 10 %), [ in, ] out
    const w = (b.ring.outer - b.ring.inner) * b.radius;
    const step = (f > 1 ? 1 : -1) * w * (Math.abs(Math.log(f)) > 0.3 ? 0.1 : 0.01);
    p.alt = Math.min(b.ring.outer * b.radius, Math.max(b.ring.inner * b.radius, p.alt + b.radius + step)) - b.radius;
    g.invalidateHud();
    return;
  }
  const lo = minOrbitAlt(b),
    hi = p.type === 'hold' ? Infinity : maxOrbitR(b) - b.radius;
  p.alt = Math.min(hi, Math.max(lo, p.alt * f));
  g.invalidateHud();
}

/**
 * Where a ring orbit starts in the planner: your own radius if you're within the ring, else its
 * densest band (sampled across it).
 */
function ringStart(b: World, r: number) {
  const ring = b.ring!;
  const lo = ring.inner * b.radius,
    hi = ring.outer * b.radius;
  if (r > lo && r < hi) return r;
  let best = (lo + hi) / 2,
    bestD = -1;
  for (let k = 1; k < 100; k++) {
    const rr = lo + ((hi - lo) * k) / 100;
    const d = ringDensity(b, rr / b.radius);
    if (d > bestD) {
      bestD = d;
      best = rr;
    }
  }
  return best;
}

export function selectOrbitType(g: Game, t: OrbitType) {
  const p = g.planner;
  if (!p) return;
  const oc = g.ship.avionics.orbit;
  if (oc && !oc.caps.types.includes(t)) {
    g.showMsg(`${unitLabel(oc)} can't fly ${ORBIT_TYPE_NAMES[t]} orbits`, 'warn');
    return;
  }
  if (t === 'ring' && (p.body.kind === 'star' || !p.body.ring)) {
    g.showMsg(`${p.body.name} has no ring`, 'warn');
    return;
  }
  if (t === 'lagrange') {
    // a planet's points; a moon plans its planet's, and a star has none
    if (p.body.kind === 'moon') p.body = p.body.parent as World;
    else if (p.body.kind === 'star') {
      g.showMsg(`${p.body.name} has no Lagrange points: pick a planet`, 'warn');
      return;
    }
    p.lk = p.lk ?? 1;
  }
  p.type = t;
  if (t === 'ring') p.alt = ringStart(p.body as World, p.curAlt + p.body.radius) - p.body.radius;
  else if (t === 'hold') p.alt = Math.max(minOrbitAlt(p.body), p.curAlt);
  else if (p.alt + p.body.radius > maxOrbitR(p.body)) p.alt = defaultOrbitAlt(p.body);
  g.invalidateHud();
}

export function reversePlannerDir(g: Game) {
  if (!g.planner) return;
  if (g.planner.type === 'lagrange') {
    // (R steps through the five points instead of reversing)
    g.planner.lk = (((g.planner.lk ?? 1) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
    g.invalidateHud();
    return;
  }
  g.planner.dir *= -1;
  g.invalidateHud();
}

export function engageOrbit(g: Game) {
  const { ship, planner } = g;
  if (!planner) return;
  const ev = evalPlan(planner, ship);
  if (!ev.ok) {
    g.showMsg(ev.note, 'warn');
    return;
  }
  const b = planner.body;
  const u = ship.pos.clone().sub(b.pos).normalize();
  if (planner.type === 'lagrange') {
    engageAutopilot(g, { body: b, type: 'lagrange', lk: planner.lk ?? 1, revs: (planner.lk ?? 1) >= 3 ? planner.revs ?? 3 : 0, r0: ev.r0, period: ev.period, n: null, point: null, station: null });
    return;
  }
  engageAutopilot(g, {
    body: b,
    type: planner.type,
    r0: ev.r0,
    period: ev.period,
    n: planner.type === 'hold' ? null : orbitNormal(b, planner.type, planner.dir, u),
    point: planner.type === 'hold' ? u.clone().multiplyScalar(ev.r0) : null, // offset from the body, which moves
    station: null,
  });
}

/** What engageAutopilot needs: the rest of an Autopilot is runtime state. */
export type ApSpec = Pick<Autopilot, 'body' | 'type' | 'r0' | 'period' | 'n' | 'point' | 'station' | 'lk' | 'revs'>;

/**
 * Hand the ship to the autopilot: from the orbit planner, or from the nav computer (which also uses
 * it for refuelling holds and station rendezvous). Takes an FTL leg first when that's worthwhile.
 */
export function engageAutopilot(g: Game, spec: ApSpec, quiet = false) {
  const { ship } = g;
  const b = spec.body;
  const ap: Autopilot = { ...spec, phase: 'insert', settled: false, t0: g.simTime, prop0: ship.prop };
  // a phasing transfer to L3–L5 starts by flying to its departure gate (sim/phasing.ts)
  if (ap.type === 'lagrange' && (ap.lk ?? 0) >= 3 && (ap.revs ?? 0) > 0) ap.ph = { stage: 'depart', tArr: 0, checks: [], dvLeft: null, resume: 1, spent: 0, stall: 0 };
  ship.ap = ap;
  g.apPanel = false;
  g.apConfirm = 0;
  closePlanner(g);
  g.jump = null;
  if (ship.mode === 'ftl') ap.phase = 'transfer';
  else if (ftlWorthwhile(g, ap)) {
    ap.phase = 'charge';
    ship.ftlCharge = FTL_CHARGE_TIME;
  }
  if (!quiet) g.showMsg(ap.phase === 'charge' ? `Autopilot · charging FTL for transfer to ${b.name}` : `Autopilot · ${apLabel(ap)}${ap.type === 'rendezvous' ? '' : ' around ' + b.name}`, 'ftl');
  startOrbitGuide(g, ap);
  return ap;
}

/** Rendezvous with a station: close on it on the station's own orbit and match its velocity. */
export function engageRendezvous(g: Game, st: Station) {
  const p = orbitBody(st);
  return engageAutopilot(g, { body: p, type: 'rendezvous', r0: st.a, period: (2 * Math.PI) / st.n, n: new THREE.Vector3().crossVectors(st.P, st.Q).normalize(), point: null, station: st });
}

/**
 * Whether the FTL leg beats flying there on thrusters: the orbit's entry point (at the right
 * altitude, in the right plane) is over AP_FTL_MIN away, and the drive can start. Distance to that
 * point counts both altitude and plane, since the FTL leg fixes both at once; judging by altitude
 * alone left a 2,300 km plane change to thrusters (a 13-minute ETA).
 */
export function ftlWorthwhile(g: Game, ap: Autopilot) {
  if (!g.ship.avionics.orbit?.caps.ftlLeg) return false; // basic units fly it all on thrusters
  if (ap.ph && ap.ph.stage !== 'depart') return false; // (a phasing transfer coasts: no FTL leg once it has left the gate)
  return apDistance(g.ship, ap) > AP_FTL_MIN && !massLock(g) && !beltLock(g) && !ftlBlocked(g.ship);
}

/**
 * During an insertion on thrusters, switch to an FTL leg if the entry point is still far (with a
 * margin, so it can't flip back and forth), e.g. once you've climbed out of a mass-lock.
 */
export function maybeFtlLeg(g: Game) {
  const { ship } = g;
  const ap = ship.ap;
  if (!ap || ap.phase !== 'insert' || ap.settled || ship.mode !== 'normal' || ship.ftlCharge > 0) return;
  if (apDistance(ship, ap) < 2 * AP_FTL_MIN || !ftlWorthwhile(g, ap)) return;
  ap.phase = 'charge';
  ship.ftlCharge = FTL_CHARGE_TIME;
  g.showMsg(`Autopilot · charging FTL for transfer to ${ap.body.name}`, 'ftl');
  startOrbitGuide(g, ap);
}

/** Seconds the disengage confirmation stays armed. */
export const AP_CONFIRM_TIME = 3;

/**
 * Ask to disengage the autopilot (Backspace or the button in its status panel). The first request
 * only arms a confirmation; a second within AP_CONFIRM_TIME disengages. Nothing else hands control
 * back (thrust keys and J are ignored while it flies), so it can't be switched off by accident.
 */
export function requestDisengage(g: Game) {
  if (!g.ship.ap) return;
  if (g.apConfirm > 0) {
    g.apConfirm = 0;
    g.apPanel = false;
    disengageAP(g, 'Autopilot disengaged');
    return;
  }
  g.apConfirm = AP_CONFIRM_TIME;
  g.showMsg('Disengage autopilot? Backspace again to confirm', 'warn');
  g.invalidateHud();
}

export function disengageAP(g: Game, reason?: string) {
  const { ship } = g;
  if (!ship.ap) return;
  const wasOrbit = ship.ap.type !== 'hold';
  ship.ap = null;
  if (ship.ftlCharge > 0) ship.ftlCharge = 0;
  if (reason) g.showMsg(reason + (wasOrbit && ship.fa ? ' · Shift+Z (flight assist off) to coast in orbit' : ''));
}

/** What the orbit preview ring (L) should show: an orbit (centre, radius, plane) or a hold point. */
export interface OrbitPreview {
  body: Body;
  r: number; // orbit radius from the body's centre, m
  n: THREE.Vector3 | null; // orbit plane normal (direction of motion by the right-hand rule); null when holding
  point: THREE.Vector3 | null; // hold point, system frame
  engaged: boolean; // the autopilot is flying it (vs. still being planned)
}

/**
 * The orbit to preview: the autopilot's while it's flying one, otherwise the planner's current
 * choice, which follows every change of type, altitude and direction. Null when neither is up
 * or the preview is switched off.
 */
export function orbitPreview(g: Game): OrbitPreview | null {
  if (!g.orbitPreview || !g.ship.avionics.orbit?.caps.preview) return null;
  const { ship } = g;
  const ap = ship.ap;
  if (ap) return { body: ap.body, r: ap.r0, n: ap.n, point: ap.type === 'hold' || ap.type === 'lagrange' ? holdPoint(ap) : null, engaged: true };
  const p = g.planner;
  if (!p) return null;
  const b = p.body;
  const r = evalPlan(p, ship).r0;
  const u = new THREE.Vector3().subVectors(ship.pos, b.pos).normalize();
  if (p.type === 'lagrange') return b.kind === 'planet' ? { body: b, r, n: null, point: lagrangePoints(b)[(p.lk ?? 1) - 1].pos, engaged: false } : null;
  if (p.type === 'hold') return { body: b, r, n: null, point: b.pos.clone().addScaledVector(u, r), engaged: false };
  return { body: b, r, n: orbitNormal(b, p.type, p.dir, u), point: null, engaged: false };
}

export function toggleOrbitPreview(g: Game) {
  const oc = g.ship.avionics.orbit;
  if (!oc?.caps.preview) {
    g.showMsg(oc ? `${unitLabel(oc)} has no orbit preview` : 'No orbit computer fitted', 'warn');
    return;
  }
  g.orbitPreview = !g.orbitPreview;
  g.showMsg(g.orbitPreview ? 'Orbit preview on' : 'Orbit preview off');
}
