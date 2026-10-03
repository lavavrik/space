/*
 * Releasing a hold at L1 or L2 (docs/lagrange.md). The point is a saddle (sim/manifold.ts): leave a
 * ship there with the tiniest push along the unstable direction and it drifts away on its own, the
 * way it would be anyway if the hold stopped, but now on the branch the pilot chose: toward the
 * planet (falling in to its neighbourhood) or away from it (out along the planet's orbit). It costs
 * a few cm/s; the drift does the rest, at e^{λt}, and time warp can carry it.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { CurrentSystem, World } from '../types';
import { fmtDist, fmtTime } from '../format';
import { gravityAt, hillRadius } from './gravity';
import { updateBodies } from './kepler';
import { minOrbitAlt } from './orbits';
import { lagrangePoints } from './lagrange';
import { saddleModes } from './manifold';
import { applyThrust } from './resources';

export type Branch = 'planet' | 'away';
/** The push (m/s): enough to pick a branch at once, small enough to cost nothing. */
export const RELEASE_DV = 0.1;

/**
 * The push and what follows it, for `planet`'s L1 or L2: the unit direction (system axes) onto the
 * branch, the e-folding rate, and how long a push of `dv` takes to carry the ship a Hill radius
 * from the point (the kick excites the growing mode with amplitude dv / 2λ).
 */
export function releasePlan(planet: World, k: 1 | 2, branch: Branch, dv = RELEASE_DV) {
  const m = saddleModes(planet, k);
  const lp = lagrangePoints(planet)[k - 1];
  const dir = m.unstable.clone();
  const toPlanet = new THREE.Vector3().subVectors(planet.pos, lp.pos);
  if (dir.dot(toPlanet) < 0 === (branch === 'planet')) dir.negate();
  const eps = dv / (2 * m.lambda);
  const hill = hillRadius(planet);
  return { dir, lambda: m.lambda, eps, tHill: Math.log(Math.max(hill / eps, 1)) / m.lambda };
}

/**
 * How close to `planet` a ship pushed off `k`'s point with velocity change `push` (system axes) comes
 * over the next `horizon` s, flown under the real force (sim/gravity.ts) from sim time `t0`. The
 * bodies are moved along their rails to do it and put back after.
 */
export function closestApproach(cur: CurrentSystem, planet: World, k: 1 | 2, push: THREE.Vector3, t0: number, horizon: number) {
  const lp = lagrangePoints(planet)[k - 1];
  const pos = lp.pos.clone(),
    v = lp.vel.clone().add(push);
  const rel = new THREE.Vector3();
  let t = 0,
    min = pos.distanceTo(planet.pos);
  while (t < horizon) {
    // steps that stay fine near the planet (a fraction of the time to cross the gap) and coarse far from it
    const dt = Math.min(3600, Math.max(30, (0.02 * rel.subVectors(pos, planet.pos).length()) / Math.max(1, v.distanceTo(planet.vel))));
    v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
    pos.addScaledVector(v, dt);
    t += dt;
    updateBodies(cur.bodies, t0 + t);
    v.addScaledVector(gravityAt(cur, pos).vec, dt / 2);
    min = Math.min(min, pos.distanceTo(planet.pos));
  }
  updateBodies(cur.bodies, t0);
  return min;
}

/** How far from a planet's centre a drifting ship must stay: its surface, its air and room to spare. */
export const safeDistance = (planet: World) => planet.radius + Math.max(minOrbitAlt(planet) * 3, planet.radius * 0.2);

/** How long a release's drift is followed: its first pass of the planet comes about a Hill radius out, which takes `tHill`. */
export const releaseHorizon = (plan: { tHill: number }) => 3 * plan.tHill;

/**
 * The push for a release onto `branch` that keeps the ship clear of the planet. The plain push goes
 * first; if its drift comes within `clearance` of the surface (the planet branch falls into the
 * planet's neighbourhood, and its first pass can meet the planet itself on a fat enough world), the
 * planner tries the same push with a sideways push added, up or down out of the orbit's plane, of
 * a size that carries the ship about the clearance off it over the drift (the out-of-plane
 * oscillation has the planet's own rate: speed ≈ clearance × n, a few m/s to a few tens), taking
 * the first that passes, or the best it found, flagged unsafe. Each is flown under the real force.
 */
export function safePush(cur: CurrentSystem, planet: World, k: 1 | 2, branch: Branch, t0: number) {
  const plan = releasePlan(planet, k, branch);
  const need = safeDistance(planet);
  const horizon = releaseHorizon(plan);
  const rel = new THREE.Vector3().subVectors(planet.pos, planet.parent.pos);
  const up = new THREE.Vector3().crossVectors(rel, new THREE.Vector3().subVectors(planet.vel, planet.parent.vel)).normalize();
  const plain = plan.dir.clone().multiplyScalar(RELEASE_DV);
  const cand: THREE.Vector3[] = [plain];
  if (branch === 'planet') {
    for (const c of [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2]) for (const sign of [1, -1]) cand.push(plain.clone().addScaledVector(up, sign * c * need * planet.orb.n));
  }
  let best = { push: cand[0], min: -Infinity };
  for (const push of cand) {
    const min = branch === 'planet' ? closestApproach(cur, planet, k, push, t0, horizon) : Infinity; // (the far branch leaves the planet behind)
    if (min > best.min) best = { push, min };
    if (min >= need) return { push, min, safe: true, need, plan };
  }
  return { push: best.push, min: best.min, safe: false, need, plan };
}

/** What a release from `planet`'s L`k` would say, for the panel. */
export function releaseNote(planet: World, k: 1 | 2) {
  const p = releasePlan(planet, k, 'planet');
  return `a ${RELEASE_DV * 100} cm/s push; ${fmtTime(p.tHill)} to drift a Hill radius (${fmtDist(hillRadius(planet))})`;
}

/** Whether the ship is in a settled hold at L1 or L2 it can be released from, else why not. */
export function canRelease(g: Game): { ok: true; planet: World; k: 1 | 2 } | { ok: false; why: string } {
  const ap = g.ship.ap;
  if (!ap || ap.type !== 'lagrange' || (ap.lk !== 1 && ap.lk !== 2)) return { ok: false, why: 'Release works from a hold at L1 or L2' };
  if (ap.ph || !ap.settled) return { ok: false, why: 'Wait until the hold is settled on the point' };
  const planet = ap.body as World;
  if (g.frameBody !== planet.parent) return { ok: false, why: 'The ship is under another world\'s pull' };
  return { ok: true, planet, k: ap.lk };
}

/** Let go of the hold with a push onto `branch`; the autopilot is disengaged. */
export function releaseFromPoint(g: Game, branch: Branch) {
  const c = canRelease(g);
  if (!c.ok) return g.showMsg(c.why, 'warn');
  const { ship } = g;
  const { push, min, safe, need, plan } = safePush(g.cur, c.planet, c.k, branch, g.simTime);
  if (!safe) return g.showMsg(`Release toward ${c.planet.name} refused · every push tried drifts within ${fmtDist(Math.max(0, min - c.planet.radius))} of its surface (needs ${fmtDist(need - c.planet.radius)}) · release away, or hold`, 'warn');
  const T = push.clone();
  applyThrust(g, T, 1);
  if (T.length() < 0.5 * push.length()) return g.showMsg('The thrusters cannot make the push', 'warn');
  ship.vel.add(T);
  ship.ap = null;
  g.apPanel = false;
  g.showMsg(`Released from ${c.planet.name} L${c.k} ${branch === 'planet' ? 'toward' : 'away from'} ${c.planet.name} · ${push.length() > RELEASE_DV * 1.01 ? `a ${push.length().toFixed(1)} m/s push to stay clear of it` : `a ${RELEASE_DV * 100} cm/s push`} · drifting off at e-fold ${fmtTime(1 / plan.lambda)}, a Hill radius in ~${fmtTime(plan.tHill)}${branch === 'planet' ? `, passing ${fmtDist(Math.max(0, min - c.planet.radius))} above its surface` : ''}`, 'ftl');
  g.invalidateHud();
}
