/*
 * Pivot (middle mouse button): turn the ship to point its nose exactly at the target (or, with no
 * target, the jump destination star) by the shortest turn, so it never rolls: roll is Q/E's alone.
 * (It used to keep the top as close as it could to where it was, which rolled the ship on the way
 * round.) Not while docked or landed: the ship is held on the pad or sits on its gear. The turn eases in fast and settles
 * precisely; it keeps tracking a moving target until it's centred to within PIVOT_DONE, and any
 * manual steering takes over. Through the periscope it's the easy way to centre something tiny.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { galPos } from './navigation';

/** Turn rate: the remaining angle shrinks by this factor per second (and at least PIVOT_MIN_RATE rad/s). */
const PIVOT_EASE = 5,
  PIVOT_MIN_RATE = 0.02;
/** Close enough (rad): about 1″, well below a pixel even at 1,000× zoom. */
const PIVOT_DONE = 5e-6;

const want = new THREE.Quaternion(),
  nose = new THREE.Vector3();

/** Middle click: start turning toward the target. */
export function startPivot(g: Game) {
  if (g.jump) {
    g.showMsg('Hyperdrive is charging · it holds the nose on the destination', 'warn');
    return;
  }
  if (g.dock?.docked || g.ship.landed) {
    g.showMsg(g.dock?.docked ? 'Docked · the ship is held on the pad' : 'Landed · lift off to turn the ship', 'warn');
    return;
  }
  if (!g.target && !g.jumpDest) {
    g.showMsg('Nothing to pivot to · target something (T, G or click)');
    return;
  }
  g.pivot = true;
  g.ship.sunTrack = false; // it would turn the ship back toward the star
}

/** Unit direction from the ship to what we're pivoting to (world), or null. */
function aimDir(g: Game) {
  if (g.target) return g.target.pos.clone().sub(g.ship.pos).normalize();
  if (g.jumpDest) return g.jumpDest.pos.clone().sub(galPos(g)).normalize(); // stars: direction only
  return null;
}

/** Each frame (real time), after manual steering: turn toward the aim point. */
export function updatePivot(g: Game, realDt: number, steered: boolean) {
  if (!g.pivot) return;
  const dir = aimDir(g);
  if (steered || !dir || g.ship.ap?.phase === 'transfer' || g.jump || g.dock?.docked || g.ship.landed) {
    g.pivot = false;
    return;
  }
  const { ship } = g;
  // the shortest turn from the nose to the aim: about an axis across both, so no roll about the nose
  nose.set(0, 0, -1).applyQuaternion(ship.q);
  want.setFromUnitVectors(nose, dir).multiply(ship.q);
  const ang = ship.q.angleTo(want);
  if (ang < PIVOT_DONE) {
    ship.q.copy(want);
    g.pivot = false;
    return;
  }
  const step = Math.max(ang * (1 - Math.exp(-PIVOT_EASE * realDt)), PIVOT_MIN_RATE * realDt);
  ship.q.rotateTowards(want, step).normalize();
}
