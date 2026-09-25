/* Orbit planner (O): pick an orbit around a body and hand it to the autopilot. */
import { FTL_CHARGE_TIME } from '../constants';
import type { Game } from '../Game';
import type { Autopilot, OrbitType } from '../types';
import { ftlBlocked, massLock } from './ftl';
import { dominantBody } from './gravity';
import { startOrbitGuide } from './guide';
import { apLabel, defaultOrbitAlt, evalPlan, maxOrbitR, minOrbitAlt, orbitNormal } from './orbits';

export function openPlanner(g: Game) {
  const { ship } = g;
  const b = g.target || (ship.grav && ship.grav.body) || dominantBody(g.cur, ship.pos);
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
    point: planner.type === 'hold' ? b.pos.clone().addScaledVector(u, ev.r0) : null,
    phase: 'insert',
    settled: false,
  };
  ship.ap = ap;
  closePlanner(g);
  g.jump = null;
  const far = Math.abs(ship.pos.distanceTo(b.pos) - ev.r0) > 3e6;
  if (ship.mode === 'ftl') ap.phase = 'transfer';
  else if (far && !massLock(g) && !ftlBlocked(ship)) {
    ap.phase = 'charge';
    ship.ftlCharge = FTL_CHARGE_TIME;
  }
  g.showMsg(ap.phase === 'charge' ? `Autopilot · charging FTL for transfer to ${b.name}` : `Autopilot · ${apLabel(ap)} around ${b.name}`, 'ftl');
  startOrbitGuide(g, ap);
}

export function disengageAP(g: Game, reason?: string) {
  const { ship } = g;
  if (!ship.ap) return;
  const wasOrbit = ship.ap.type !== 'hold';
  ship.ap = null;
  if (ship.ftlCharge > 0) ship.ftlCharge = 0;
  if (reason) g.showMsg(reason + (wasOrbit && ship.fa ? ' · press Z (flight assist off) to coast in orbit' : ''));
}
