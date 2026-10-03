/*
 * Releasing a hold at L1 or L2 (docs/lagrange.md). The point is a saddle (sim/manifold.ts): leave a
 * ship there with the tiniest push along the unstable direction and it drifts away on its own, the
 * way it would be anyway if the hold stopped, but now on the branch the pilot chose: toward the
 * planet (falling in to its neighbourhood) or away from it (out along the planet's orbit). It costs
 * a few cm/s; the drift does the rest, at e^{λt}, and time warp can carry it.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { World } from '../types';
import { fmtDist, fmtTime } from '../format';
import { hillRadius } from './gravity';
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
  const plan = releasePlan(c.planet, c.k, branch);
  const T = plan.dir.clone().multiplyScalar(RELEASE_DV);
  applyThrust(g, T, 1);
  if (T.length() < 0.5 * RELEASE_DV) return g.showMsg('The thrusters cannot make the push', 'warn');
  ship.vel.add(T);
  ship.ap = null;
  g.apPanel = false;
  g.showMsg(`Released from ${c.planet.name} L${c.k} ${branch === 'planet' ? 'toward' : 'away from'} ${c.planet.name} · drifting off at e-fold ${fmtTime(1 / plan.lambda)}, a Hill radius in ~${fmtTime(plan.tHill)}`, 'ftl');
  g.invalidateHud();
}
