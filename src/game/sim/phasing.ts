/*
 * Phasing transfers (docs/lagrange.md). L3, L4 and L5 are free orbits with the planet's own period,
 * so the cheap way to them is not to match their velocity in one go (about the planet's orbital
 * speed for L4) but to change your orbital period a little, drift round to them over a few orbits,
 * and change it back:
 *
 *   1. leave from the departure gate (`gatePoint`: a free point on the planet's own orbit, outside its
 *      pull), burning onto an orbit whose period makes you arrive in N orbits' time,
 *      T = (N + the phase to cover) × the planet's period. From the gate the plan is exact: the
 *      phasing orbit passes through the gate, you come back to it after N turns, and the point has
 *      moved to meet you there;
 *   2. coast (time warp works), with small mid-course corrections, because the planet's pull near
 *      the start, which the plan leaves out, bends the path;
 *   3. match the point on arrival (the hold does that).
 *
 * The cost falls with N: a 60° lead (L4) costs about v / (9N) in all, 1.1 km/s over three orbits at
 * Earth's 30 km/s, 0.3 km/s over a dozen. Everything is Kepler orbits round the parent, relative to
 * it (the same frame the ship's velocity is kept in), so the planning needs no integration: only a
 * propagator (universal variables, good for any number of orbits) and a Newton shooting solver on
 * the departure velocity.
 */
import { THREE } from '../lib/three';
import type { World } from '../types';
import { TROJAN_SHIFT, gatePoint, trojanRel } from './lagrange';
import { meanAnomalyOf } from './kepler';

const V = () => new THREE.Vector3();

/** Stumpff functions C(z) and S(z). */
function stumpff(z: number): [number, number] {
  if (Math.abs(z) < 1e-8) return [1 / 2 - z / 24, 1 / 6 - z / 120];
  if (z > 0) {
    const s = Math.sqrt(z);
    return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * s * s)];
  }
  const s = Math.sqrt(-z);
  return [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * s * s)];
}

/**
 * State after `dt` s on the Kepler orbit through (r0, v0) round a body with gravitational parameter
 * `mu`, by the universal-variable form (any conic, any number of orbits: no reduction mod the
 * period, so the result stays differentiable in v0, which the solver relies on).
 */
export function propagate(r0: THREE.Vector3, v0: THREE.Vector3, mu: number, dt: number, outR = V(), outV = V()) {
  const r0m = r0.length();
  const sm = Math.sqrt(mu);
  const vr0 = r0.dot(v0) / sm;
  const alpha = 2 / r0m - v0.lengthSq() / mu;
  let chi = sm * Math.abs(alpha) * dt; // exact for a circle; Newton does the rest
  if (alpha < 1e-12) chi = (sm * dt) / r0m; // (parabolic or hyperbolic: not what phasing flies, but safe)
  let C = 0,
    S = 0,
    r = r0m;
  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    [C, S] = stumpff(z);
    r = chi * chi * C + vr0 * chi * (1 - z * S) + r0m * (1 - z * C);
    const F = vr0 * chi * chi * C + (1 - alpha * r0m) * chi * chi * chi * S + r0m * chi - sm * dt;
    const d = F / r;
    chi -= d;
    if (Math.abs(d) < 1e-12 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  [C, S] = stumpff(z);
  r = chi * chi * C + vr0 * chi * (1 - z * S) + r0m * (1 - z * C);
  const f = 1 - (chi * chi * C) / r0m;
  const g = dt - (chi * chi * chi * S) / sm;
  const fd = (sm / (r * r0m)) * chi * (z * S - 1);
  const gd = 1 - (chi * chi * C) / r;
  outR.copy(r0).multiplyScalar(f).addScaledVector(v0, g);
  outV.copy(r0).multiplyScalar(fd).addScaledVector(v0, gd);
  return { r: outR, v: outV };
}

/** Solve [c0 c1 c2] x = b for x (Cramer's rule), or null if the matrix is singular. */
function solve3(c: THREE.Vector3[], b: THREE.Vector3) {
  const det = (a: THREE.Vector3, d: THREE.Vector3, e: THREE.Vector3) => a.dot(new THREE.Vector3().crossVectors(d, e));
  const D = det(c[0], c[1], c[2]);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-30) return null;
  return new THREE.Vector3(det(b, c[1], c[2]) / D, det(c[0], b, c[2]) / D, det(c[0], c[1], b) / D);
}

/**
 * The velocity at `r0` that takes the ship to `target` in `T` s, found by Newton on the three
 * components from `guess` (numerical Jacobian, halved steps when a step makes things worse). Returns
 * the velocity and the miss left (m); a miss over a few hundred metres means it didn't converge.
 */
export function solveVelocity(r0: THREE.Vector3, guess: THREE.Vector3, mu: number, T: number, target: THREE.Vector3) {
  const v = guess.clone();
  const rEnd = V(),
    vEnd = V(),
    probe = V();
  const miss = (vel: THREE.Vector3) => propagate(r0, vel, mu, T, rEnd, vEnd).r.clone().sub(target);
  let res = miss(v);
  for (let it = 0; it < 60 && res.length() > 50; it++) {
    const h = Math.max(1e-3, 1e-7 * v.length()); // m/s
    const cols: THREE.Vector3[] = [];
    for (let c = 0; c < 3; c++) {
      probe.copy(v);
      probe.setComponent(c, v.getComponent(c) + h);
      cols.push(miss(probe).sub(res).divideScalar(h));
    }
    const step = solve3(cols, res);
    if (!step) break;
    let k = 1;
    for (let tries = 0; tries < 10; tries++, k /= 2) {
      probe.copy(v).addScaledVector(step, -k);
      const r2 = miss(probe);
      if (r2.length() < res.length()) {
        v.copy(probe);
        res = r2;
        break;
      }
      if (tries === 9) return { v, miss: res.length() };
    }
  }
  return { v, miss: res.length() };
}

/** Wrap to (−½, ½]. */
const wrap = (x: number) => x - Math.ceil(x - 0.5);

export interface PhasingPlan {
  ok: boolean;
  /** Why not, when it isn't ok. */
  why?: string;
  /** Velocity to burn onto (relative to the parent), and the burn. */
  v1: THREE.Vector3;
  dv1: THREE.Vector3;
  /** Time of flight (s), and the speed still to be matched on arrival (m/s). */
  T: number;
  dv2: number;
  /** The miss the solver left (m). */
  miss: number;
  /** Orbits of the phasing orbit. */
  N: number;
}

/**
 * Plan the departure burn to L3, L4 or L5 of `planet` after `N` orbits, from a state (r0, v0)
 * relative to the parent at sim time `t0`. The flight time is set by the phase to cover: the angle
 * from the ship to the point, taken the short way, plus N planet periods; then the velocity is
 * solved so the Kepler orbit through r0 reaches the point's position then. `dv2` is the speed
 * mismatch left on arrival (what the hold has to burn to match the point).
 */
export function planPhasing(planet: World, k: 3 | 4 | 5, r0: THREE.Vector3, v0: THREE.Vector3, t0: number, N: number): PhasingPlan {
  const mu = planet.parent.mu;
  const o = planet.orb;
  const fail = (why: string): PhasingPlan => ({ ok: false, why, v1: v0.clone(), dv1: V(), T: 0, dv2: 0, miss: Infinity, N });
  if (N < 1) return fail('needs at least one orbit');
  // phase to cover: how far (in turns, taken the short way) the ship's place on the planet's orbit
  // (its mean anomaly there) is ahead of the point's now; exact when it is on that orbit, as it is at the gate
  const pr = V(),
    pv = V();
  const M0 = o.M0 + o.n * t0;
  trojanRel(planet, k, M0, pr, pv);
  const phase = wrap((meanAnomalyOf(o, r0) - (M0 + TROJAN_SHIFT[k])) / (2 * Math.PI)); // ship ahead of the point, in turns
  const P = (2 * Math.PI) / o.n;
  const T = P * (N + phase);
  // the point's place on arrival
  const target = V(),
    vt = V();
  trojanRel(planet, k, M0 + o.n * T, target, vt);
  // first guess: the orbit through r0 with the period T / N, keeping the flight-path angle
  const aP = Math.cbrt((mu * (T / N) ** 2) / (4 * Math.PI * Math.PI));
  const v2 = mu * (2 / r0.length() - 1 / aP);
  if (v2 <= 0) return fail('no orbit with that period passes here');
  const guess = v0.clone().multiplyScalar(Math.sqrt(v2) / v0.length());
  const { v, miss } = solveVelocity(r0, guess, mu, T, target);
  const end = propagate(r0, v, mu, T);
  return { ok: miss < 5e3, why: miss < 5e3 ? undefined : 'the plan did not close', v1: v, dv1: v.clone().sub(v0), T, dv2: end.v.distanceTo(vt), miss, N };
}

/** Mid-course correction: the velocity change at (r, v) that still reaches `target` in `Tleft` s. */
export function correction(r: THREE.Vector3, v: THREE.Vector3, mu: number, Tleft: number, target: THREE.Vector3) {
  const { v: v1, miss } = solveVelocity(r, v, mu, Tleft, target);
  return { dv: v1.clone().sub(v), miss };
}

/**
 * What a phasing transfer to L3, L4 or L5 would cost with `N` orbits, planned from the departure
 * gate as it is now (so it needs no clock): the flight time, and the Δv of both ends (the departure
 * burn, and the speed matched on arrival).
 */
export function phasingEstimate(planet: World, k: 3 | 4 | 5, N: number) {
  const gate = gatePoint(planet, k);
  const par = planet.parent;
  const r0 = gate.pos.clone().sub(par.pos),
    v0 = gate.vel.clone().sub(par.vel);
  const o = planet.orb;
  // the time at which the planet's mean anomaly is what it is now, so the plan reads the same phase
  const t0 = (meanAnomalyOf(o, planet.pos.clone().sub(par.pos)) - o.M0) / o.n;
  const plan = planPhasing(planet, k, r0, v0, t0, N);
  return { ok: plan.ok, T: plan.T, dv: plan.dv1.length() + plan.dv2 };
}
