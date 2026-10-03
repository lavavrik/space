import { atmoOf } from './atmosphere';
import { AP_ACC, AU, SHIP, WT } from '../constants';
import { fmtFlow, fmtSpeedText, fmtTime } from '../format';
import { THREE } from '../lib/three';
import type { Autopilot, Body, OrbitType, Planner, Ship } from '../types';
import { TIDE_FROM } from './gravity';
import { driftTime, lagrangePoints, lpointWhere, phasingReaches } from './lagrange';
import { phasingEstimate } from './phasing';
import { deltaVLeft, shipMass } from './resources';
import { ringDensity } from './rings';

export const ORBIT_TYPES: OrbitType[] = ['equatorial', 'polar', 'sync', 'hold', 'ring', 'lagrange'];

export function minOrbitAlt(b: Body) {
  if (b.kind === 'star') return b.radius * 0.5;
  // above the air (sim/atmosphere.ts): drag would bring a lower orbit down
  const air = atmoOf(b);
  return b.pal.atmo ? Math.max(b.radius * 0.03, air ? air.top : 0) : Math.max(5e3, b.radius * 0.005);
}

export function maxOrbitR(b: Body) {
  // (a wide pair's star: within its Roche lobe.) A world: below where its parent's tide starts
  // (sim/gravity.ts TIDE_FROM), so an orbit stays an exact Kepler orbit, the settled autopilot can
  // coast and time warp's rails hold it. At the old 0.8 SOI the tide pulled a settled orbit out of
  // the autopilot's band in 3 days and out of the SOI within 3 orbits: seconds under time warp.
  return b.kind === 'star' ? Math.min(150 * AU, b.soi * 0.8) : b.soi * TIDE_FROM;
}

export function defaultOrbitAlt(b: Body) {
  if (b.kind === 'star') return b.radius * 2;
  return Math.max(minOrbitAlt(b) * 1.5, b.radius * (b.type >= WT.GasGiant ? 0.3 : 0.08));
}

/** Radius of the orbit whose period matches the body's rotation. */
export function syncRadius(b: Body) {
  return Math.cbrt(b.mu / (b.spin * b.spin));
}

export interface PlanEval {
  /** Lagrange holds: how it gets there, for the planner's TRANSFER row. */
  transfer?: string;
  r0: number;
  ok: boolean;
  note: string;
  period: number;
  speed: number;
  warn?: boolean;
}

export function evalPlan(p: Planner, ship: Ship): PlanEval {
  if (p.type === 'lagrange') return evalLagrange(p, ship);
  const b = p.body,
    rMin = b.radius + minOrbitAlt(b),
    rMax = maxOrbitR(b);
  let r0 = b.radius + p.alt,
    ok = true,
    note = '';
  if (rMax < rMin) {
    const parent = b.kind === 'star' ? '' : b.parent.name;
    return { r0, ok: p.type === 'hold', note: `${b.name} sits too deep in ${parent}'s gravity for a stable orbit`, period: NaN, speed: 0 };
  }
  if (p.type === 'ring') {
    // in the ring's plane at a radius within it, prograde with its rocks (sim/rings.ts)
    if (!b.kind || b.kind === 'star' || !b.ring) return { r0, ok: false, note: `${b.name} has no ring`, period: NaN, speed: 0 };
    const lo = b.ring.inner * b.radius,
      hi = b.ring.outer * b.radius;
    r0 = Math.min(hi, Math.max(lo, r0));
    const dens = ringDensity(b, r0 / b.radius) / 0.85;
    const where = dens <= 0.02 ? 'in a gap: open space' : dens < 0.35 ? 'in a sparse band' : dens < 0.7 ? 'among the rocks' : 'in a dense band';
    const period = 2 * Math.PI * Math.sqrt(r0 ** 3 / b.mu);
    return { r0, ok: true, note: `In the ring's plane ${where}, moving with its rocks: they drift past slowly. Inside the belt flight assist holds you against them.`, period, speed: Math.sqrt(b.mu / r0) };
  }
  if (p.type === 'sync') {
    r0 = syncRadius(b);
    const hrs = (2 * Math.PI) / b.spin / 3600;
    if (r0 < rMin) {
      ok = false;
      note = `Spins too fast (${hrs.toFixed(1)} h day): synchronous orbit would be underground`;
    } else if (r0 > rMax) {
      ok = false;
      note = `Spins too slowly (${hrs.toFixed(1)} h day): synchronous orbit lies outside its gravity`;
    } else note = `Matches the ${hrs.toFixed(1)} h rotation: you stay over the same ground`;
  } else if (p.type === 'hold') {
    const g = b.mu / (r0 * r0);
    // hovering means burning g of Δv every second: mass flow = m·g / ve
    const flow = (shipMass(ship) * g) / SHIP.ve;
    const lasts = g > 0 ? deltaVLeft(ship) / g : Infinity;
    note =
      g > AP_ACC
        ? `Gravity here is ${g.toFixed(0)} m/s², above the ship's ${AP_ACC} m/s² of thrust. You will sink.`
        : `Hovering fights ${g.toFixed(2)} m/s² of gravity: ${fmtFlow(flow)} of propellant, so the tank lasts ${fmtTime(lasts)}. An orbit costs nothing once you're in it.`;
    return { r0, ok, note, period: NaN, speed: 0, warn: g > AP_ACC || lasts < 1800 };
  }
  if (p.type !== 'sync' && (r0 < rMin || r0 > rMax)) {
    ok = false;
    note = 'Altitude out of range';
  }
  if (!note) note = 'Free once established: an orbit needs no thrust to stay in.';
  return { r0, ok, note, period: 2 * Math.PI * Math.sqrt(r0 ** 3 / b.mu), speed: Math.sqrt(b.mu / r0) };
}

/**
 * A Lagrange hold (docs/lagrange.md): `r0` is the point's distance from the planet. Free at the
 * stable points; at the unstable ones (L1, L2, L3) the drift has to be flown out now and then.
 */
function evalLagrange(p: Planner, ship: Ship): PlanEval {
  const b = p.body;
  if (b.kind === 'star') return { r0: 0, ok: false, note: `L-points are held for planets and moons: ${b.name} has none`, period: NaN, speed: 0 };
  const k = p.lk ?? 1;
  const lp = lagrangePoints(b)[k - 1];
  const r0 = lp.pos.distanceTo(b.pos);
  const where = lpointWhere(b, k);
  const kind = b.kind === 'moon' ? 'moon' : 'planet';
  const days = driftTime(lp) / 86400;
  let note = lp.stable
    ? `${lp.name}: ${where}. Stable: a ship left here stays with the ${kind}, no thrust needed.`
    : `${lp.name}: ${where}. Unstable: a ship left here drifts away over ~${days < 400 ? Math.round(days) + ' days' : (days / 365.25).toFixed(0) + ' years'}; the autopilot flies it back (real missions burn ~${lp.dvYear.toFixed(1)} m/s a year).`;
  let transfer = 'direct';
  let ok = true,
    warn = false;
  const left = deltaVLeft(ship);
  if (k >= 3) {
    const reaches = phasingReaches(b, k);
    const N = reaches ? (p.revs ?? 3) : 0;
    if (N > 0) {
      const est = phasingEstimate(b, k as 3 | 4 | 5, N);
      transfer = `${N} orbit${N > 1 ? 's' : ''} · ${fmtTime(est.T)}${est.dv < 300 ? ' · low-energy' : ''}`;
      note += ` Phasing: FTL to a point on the ${kind}'s own orbit, then a ${fmtSpeedText(est.dv / 2)} burn onto a slightly different orbit and ${fmtTime(est.T)} of coasting (time warp works) round to it; ${fmtSpeedText(est.dv)} of Δv in all. More orbits cost less.`;
      if (!est.ok) {
        ok = false;
        note = `The transfer cannot be planned for this ${kind}.`;
      } else if (left < est.dv * 1.1 + 50) {
        ok = false;
        warn = true;
        note += ` Not enough Δv: ${fmtSpeedText(left)} left.`;
      }
    } else {
      const dv = lp.vel.distanceTo(b.vel);
      transfer = 'straight there';
      note += ` Straight there: FTL, then ${fmtSpeedText(dv)} of Δv to match its orbit. ${reaches ? '([ ] sets orbits for a phasing transfer, which costs far less.)' : `(No phasing: ${b.name}'s pull reaches past the point, so a transfer can't start clear of it.)`}`;
      if (left < dv * 1.1 + 50) {
        ok = false;
        warn = true;
        note += ` Not enough Δv: ${fmtSpeedText(left)} left.`;
      }
    }
  }
  return { r0, ok, note, period: (2 * Math.PI) / b.orb.n, speed: lp.vel.distanceTo(b.vel), transfer, warn };
}

/** Normal of the target orbit plane. `u` is the unit vector from the body to the ship. */
export function orbitNormal(b: Body, type: OrbitType, dir: number, u: THREE.Vector3) {
  if (type === 'polar') {
    const n = new THREE.Vector3().crossVectors(b.axis, u);
    if (n.lengthSq() < 1e-8) n.set(1, 0, 0).cross(b.axis);
    return n.normalize().multiplyScalar(dir);
  }
  return b.axis.clone().multiplyScalar(type === 'sync' || type === 'ring' ? 1 : dir); // the ring and a stationary orbit go the world's way round
}

export function apLabel(ap: Autopilot) {
  return { equatorial: 'equatorial orbit', polar: 'polar orbit', sync: 'synchronous orbit', hold: 'holding position', ring: 'ring orbit', lagrange: `holding at ${ap.body.name} L${ap.lk}`, rendezvous: `rendezvous with ${ap.station?.name}` }[ap.type];
}
