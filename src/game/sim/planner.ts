/* Orbit planner (O): pick an orbit around a body and hand it to the autopilot. */
import { AP_FTL_MIN, FTL_CHARGE_TIME } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Autopilot, Body, OrbitType } from '../types';
import { apInsertion, holdPoint } from './autopilot';
import { ftlBlocked, massLock } from './ftl';
import { dominantBody } from './gravity';
import { startOrbitGuide } from './guide';
import { apLabel, defaultOrbitAlt, evalPlan, maxOrbitR, minOrbitAlt, orbitNormal } from './orbits';

export function openPlanner(g: Game) {
  const { ship } = g;
  // a targeted station plans an orbit around the world it circles
  const t = g.target && g.target.kind === 'station' ? g.target.parent : g.target;
  const b = t || (ship.grav && ship.grav.body) || dominantBody(g.cur, ship.pos);
  const curAlt = ship.pos.distanceTo(b.pos) - b.radius;
  g.planner = { body: b, type: 'equatorial', alt: defaultOrbitAlt(b), dir: 1, curAlt };
  g.invalidateHud();
}

export function closePlanner(g: Game) {
  g.planner = null;
  g.invalidateHud();
}

export function adjustAlt(g: Game, f: number) {
  const p = g.planner;
  if (!p || p.type === 'sync') return;
  const b = p.body;
  const lo = minOrbitAlt(b),
    hi = p.type === 'hold' ? Infinity : maxOrbitR(b) - b.radius;
  p.alt = Math.min(hi, Math.max(lo, p.alt * f));
  g.invalidateHud();
}

export function selectOrbitType(g: Game, t: OrbitType) {
  const p = g.planner;
  if (!p) return;
  p.type = t;
  if (t === 'hold') p.alt = Math.max(minOrbitAlt(p.body), p.curAlt);
  else if (p.alt + p.body.radius > maxOrbitR(p.body)) p.alt = defaultOrbitAlt(p.body);
  g.invalidateHud();
}

export function reversePlannerDir(g: Game) {
  if (!g.planner) return;
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
  const ap: Autopilot = {
    body: b,
    type: planner.type,
    r0: ev.r0,
    period: ev.period,
    n: planner.type === 'hold' ? null : orbitNormal(b, planner.type, planner.dir, u),
    point: planner.type === 'hold' ? u.clone().multiplyScalar(ev.r0) : null, // offset from the body, which moves
    phase: 'insert',
    settled: false,
    t0: g.simTime,
    prop0: ship.prop,
  };
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
  g.showMsg(ap.phase === 'charge' ? `Autopilot · charging FTL for transfer to ${b.name}` : `Autopilot · ${apLabel(ap)} around ${b.name}`, 'ftl');
  startOrbitGuide(g, ap);
}

/**
 * Whether the FTL leg beats flying there on thrusters: the orbit's entry point (at the right
 * altitude, in the right plane) is over AP_FTL_MIN away, and the drive can start. Distance to that
 * point counts both altitude and plane, since the FTL leg fixes both at once; judging by altitude
 * alone left a 2,300 km plane change to thrusters (a 13-minute ETA).
 */
export function ftlWorthwhile(g: Game, ap: Autopilot) {
  return apInsertion(g.ship, ap).P.distanceTo(g.ship.pos) > AP_FTL_MIN && !massLock(g) && !ftlBlocked(g.ship);
}

/**
 * During an insertion on thrusters, switch to an FTL leg if the entry point is still far (with a
 * margin, so it can't flip back and forth), e.g. once you've climbed out of a mass-lock.
 */
export function maybeFtlLeg(g: Game) {
  const { ship } = g;
  const ap = ship.ap;
  if (!ap || ap.phase !== 'insert' || ap.settled || ship.mode !== 'normal' || ship.ftlCharge > 0) return;
  if (apInsertion(ship, ap).P.distanceTo(ship.pos) < 2 * AP_FTL_MIN || !ftlWorthwhile(g, ap)) return;
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
  if (reason) g.showMsg(reason + (wasOrbit && ship.fa ? ' · press Z (flight assist off) to coast in orbit' : ''));
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
  if (!g.orbitPreview) return null;
  const { ship } = g;
  const ap = ship.ap;
  if (ap) return { body: ap.body, r: ap.r0, n: ap.n, point: ap.type === 'hold' ? holdPoint(ap) : null, engaged: true };
  const p = g.planner;
  if (!p) return null;
  const b = p.body;
  const r = evalPlan(p, ship).r0;
  const u = new THREE.Vector3().subVectors(ship.pos, b.pos).normalize();
  if (p.type === 'hold') return { body: b, r, n: null, point: b.pos.clone().addScaledVector(u, r), engaged: false };
  return { body: b, r, n: orbitNormal(b, p.type, p.dir, u), point: null, engaged: false };
}

export function toggleOrbitPreview(g: Game) {
  g.orbitPreview = !g.orbitPreview;
  g.showMsg(g.orbitPreview ? 'Orbit preview on' : 'Orbit preview off');
}
