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
import { dominantBody } from './gravity';
import { syncFrame } from './frame';

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
  if (g.route?.running) return 'not while a route is flying';
  if (ship.ap && (!ship.ap.settled || ship.ap.type === 'hold' || ship.ap.type === 'rendezvous')) return 'not while the autopilot is manoeuvring';
  const thrusting = keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD || keys.Space || keys.KeyC || keys.ControlLeft || keys.ControlRight || keys.KeyX;
  if (thrusting) return 'not under thrust';
  const t = timeToImpact(g);
  if (t < IMPACT_MARGIN) return 'impact imminent';
  return null;
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
  if (ship.landed || vr >= 0) return Infinity;
  // falling: time to cover the altitude at the current radial speed plus gravity's pull (an
  // underestimate of the time, so it errs on the side of stopping early)
  const h = r - b.radius,
    gAcc = b.mu / (r * r);
  return (vr + Math.sqrt(vr * vr + 2 * gAcc * h)) / gAcc;
}

const rel = new THREE.Vector3(),
  acc = new THREE.Vector3();

/**
 * Coast the ship for `dt` sim seconds relative to its frame body (which advanceBodies has already
 * moved, carrying the ship with it). Drops the warp if the orbit needs finer steps than a frame can
 * afford, or an impact comes within IMPACT_MARGIN.
 */
export function railsStep(g: Game, dt: number) {
  const { ship } = g;
  if (ship.landed) return; // resting on the ground: stays put
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
    return acc.copy(rel).multiplyScalar(-b.mu / (r * r * r));
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
