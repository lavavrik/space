import { atmoOf } from './atmosphere';
import { AP_ACC, AU, SHIP, WT } from '../constants';
import { fmtFlow, fmtTime } from '../format';
import { THREE } from '../lib/three';
import type { Autopilot, Body, OrbitType, Planner, Ship } from '../types';
import { deltaVLeft, shipMass } from './resources';
import { ringDensity } from './rings';

export const ORBIT_TYPES: OrbitType[] = ['equatorial', 'polar', 'sync', 'hold', 'ring'];

export function minOrbitAlt(b: Body) {
  if (b.kind === 'star') return b.radius * 0.5;
  // above the air (sim/atmosphere.ts): drag would bring a lower orbit down
  const air = atmoOf(b);
  return b.pal.atmo ? Math.max(b.radius * 0.03, air ? air.top : 0) : Math.max(5e3, b.radius * 0.005);
}

export function maxOrbitR(b: Body) {
  return b.kind === 'star' ? 150 * AU : b.soi * 0.8;
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
  r0: number;
  ok: boolean;
  note: string;
  period: number;
  speed: number;
  warn?: boolean;
}

export function evalPlan(p: Planner, ship: Ship): PlanEval {
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
  return { equatorial: 'equatorial orbit', polar: 'polar orbit', sync: 'synchronous orbit', hold: 'holding position', ring: 'ring orbit', rendezvous: `rendezvous with ${ap.station?.name}` }[ap.type];
}
