/*
 * Time warp (`.` faster, `,` slower): the simulation runs up to 100,000× real time, so moons and
 * planets visibly orbit and spin. Like any sim with warp, the ship goes "on rails" while it runs:
 * no thrust, it just coasts under its frame body's gravity (patched conics, like normal flight),
 * integrated with symplectic (kick-drift-kick) substeps short enough to keep even a low orbit
 * stable. Everything else (bodies, stations, power, heat, scooping) just takes the longer step.
 *
 * Warp won't start, and drops back to 1×, whenever the ship needs to be flown: in FTL, charging a
 * drive, jumping, venting, on a route, during an autopilot manoeuvre or hover, on thrust input, and
 * about a minute (sim time) before an impact.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { dominantBody, perturbation } from './gravity';
import { syncFrame } from './frame';
import { surfaceRadius } from './terrain';

export const WARP_LEVELS = [1, 10, 100, 1000, 10000, 100000];

/** Substeps per frame at most; a bigger frame step means the warp is too high for this orbit. */
const MAX_SUBSTEPS = 400;
/** Each substep is at most this fraction of the local orbital period. */
const STEP_OF_PERIOD = 0.004;
/** Warp stops when an impact is closer than this (sim seconds). */
const IMPACT_MARGIN = 60;

/** Why time can't be warped right now, if it can't. */
export function warpBlocked(g: Game): string | null {
  const { ship, keys } = g;
  if (ship.dead) return 'ship lost';
  if (ship.mode === 'ftl') return 'not in FTL';
  if (g.jump) return 'not during a hyperjump';
  if (ship.ftlCharge > 0) return 'not while a drive charges';
  if (ship.vent) return 'not while venting hydrogen';
  if (g.route?.running && ship.ap?.ph?.stage !== 'coast') return 'not while a route is flying'; // (a route's phasing coast is what warp is for)
  if (g.inStation && !g.dock?.docked) return 'not inside a station';
  if (g.autodock) return 'not while the docking computer flies';
  if (g.ascent) return 'not during the ascent';
  // a phasing transfer's long coast is what warp is for; its burns need real time (see phasingWarpCap)
  const coasting = ship.ap?.ph?.stage === 'coast';
  if (ship.ap && !coasting && (!ship.ap.settled || ship.ap.type === 'hold' || ship.ap.type === 'lagrange' || ship.ap.type === 'rendezvous')) return 'not while the autopilot is manoeuvring';
  const thrusting = keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD || keys.Space || keys.KeyC || keys.ControlLeft || keys.ControlRight || keys.KeyX;
  if (thrusting) return 'not under thrust';
  const t = timeToImpact(g);
  if (t < IMPACT_MARGIN) return 'impact imminent';
  return null;
}

/**
 * While a phasing transfer coasts, hold warp short of its next event (a mid-course correction, or
 * arrival) so that it comes at 1×, on time: a frame must not step over it. The warp the pilot had
 * is remembered and put back after the burn (sim/autopilot.ts phasingFlight).
 */
export function phasingWarpCap(g: Game) {
  const ph = g.ship.ap?.ph;
  if (!ph || ph.stage !== 'coast' || g.warp <= 1) return;
  const room = (ph.checks[0] - g.simTime) / 0.05; // the biggest warp whose frame (~16 ms of real time) fits well inside the wait
  if (g.warp <= room) return;
  ph.resume = Math.max(ph.resume, g.warp);
  let w = 1;
  for (const l of WARP_LEVELS) if (l <= room) w = l;
  g.warp = w;
}

/** Step the warp level up or down (clamped). Starting it is refused with the reason. */
export function changeWarp(g: Game, step: 1 | -1) {
  const i = Math.max(0, WARP_LEVELS.indexOf(g.warp));
  const next = WARP_LEVELS[Math.max(0, Math.min(WARP_LEVELS.length - 1, i + step))];
  if (next === g.warp) return;
  if (next > 1) {
    const why = warpBlocked(g);
    if (why) {
      g.showMsg(`Time warp · ${why}`, 'warn');
      return;
    }
  }
  g.warp = next;
  g.showMsg(next === 1 ? 'Time warp off' : `Time warp ×${next.toLocaleString('en-US')} · , slows, . speeds up`);
}

/** Back to real time, saying why. */
export function stopWarp(g: Game, why: string) {
  if (g.warp === 1) return;
  g.warp = 1;
  g.showMsg(`Time warp off · ${why}`, 'warn');
}

/** Sim seconds until the ship hits its frame body coasting as it is (Infinity if it won't soon). */
function timeToImpact(g: Game) {
  const { ship } = g;
  const b = g.frameBody;
  const rel = ship.pos.clone().sub(b.pos);
  const r = rel.length();
  const vr = ship.vel.dot(rel) / r;
  // (on the ground, or docked: held up, not falling; a sky station's pad counted as a free fall)
  if (ship.landed || g.dock?.docked || vr >= 0) return Infinity;
  // falling: time to cover the altitude at the current radial speed plus gravity's pull (an
  // underestimate of the time, so it errs on the side of stopping early)
  const h = r - surfaceRadius(b, ship.pos),
    gAcc = b.mu / (r * r);
  return (vr + Math.sqrt(vr * vr + 2 * gAcc * h)) / gAcc;
}

const rel = new THREE.Vector3(),
  acc = new THREE.Vector3(),
  qSpin = new THREE.Quaternion(),
  pAt = new THREE.Vector3(),
  pert = new THREE.Vector3();

/**
 * Coast the ship for `dt` sim seconds relative to its frame body (which advanceBodies has already
 * moved, carrying the ship with it). Drops the warp if the orbit needs finer steps than a frame can
 * afford, or an impact comes within IMPACT_MARGIN.
 */
export function railsStep(g: Game, dt: number) {
  const { ship } = g;
  if (ship.landed) {
    // resting on the ground: turns with the world (sim/terrain.ts), so it stays on its spot
    const lb = ship.landed;
    if (lb.kind !== 'star') {
      const ang = lb.spin * dt;
      rel.subVectors(ship.pos, lb.pos).applyAxisAngle(lb.axis, ang);
      ship.pos.addVectors(lb.pos, rel);
      ship.q.premultiply(qSpin.setFromAxisAngle(lb.axis, ang));
      // and moving with the ground where it is now: the velocity kept its old heading, and back at
      // ×1 the ship slid off the turned ground and flew up ~80 m before it settled
      ship.vel.copy(lb.axis).multiplyScalar(lb.spin).cross(rel).add(lb.vel).sub(g.frameBody.vel);
    }
    return;
  }
  const b = g.frameBody;
  rel.subVectors(ship.pos, b.pos);
  const r0 = rel.length();
  const period = 2 * Math.PI * Math.sqrt(r0 ** 3 / b.mu);
  let n = Math.ceil(dt / (STEP_OF_PERIOD * period));
  if (n > MAX_SUBSTEPS) {
    n = MAX_SUBSTEPS;
    const i = WARP_LEVELS.indexOf(g.warp);
    if (i > 1) {
      g.warp = WARP_LEVELS[i - 1];
      g.showMsg(`Time warp ×${g.warp.toLocaleString('en-US')} · this orbit is too tight to go faster`, 'warn');
    }
  }
  const h = dt / n;
  const accel = () => {
    const r = rel.length();
    // (the bodies hold still for the frame's step; fine, they move far less than their reach)
    return acc.copy(rel).multiplyScalar(-b.mu / (r * r * r)).add(perturbation(g.cur, b, pAt.addVectors(b.pos, rel), pert));
  };
  for (let k = 0; k < n; k++) {
    ship.vel.addScaledVector(accel(), h / 2);
    rel.addScaledVector(ship.vel, h);
    ship.vel.addScaledVector(accel(), h / 2);
  }
  ship.pos.addVectors(b.pos, rel);
  const next = dominantBody(g.cur, ship.pos);
  if (next !== b) syncFrame(g, next);
  if (timeToImpact(g) < IMPACT_MARGIN) stopWarp(g, `impact on ${g.frameBody.name} within a minute`);
}
