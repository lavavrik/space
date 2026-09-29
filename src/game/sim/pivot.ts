/*
 * Pivot (middle mouse button): turn the ship to point its nose exactly at the target (or, with no
 * target, the jump destination star) by the shortest turn, so it never rolls: roll is Q/E's alone.
 * (It used to keep the top as close as it could to where it was, which rolled the ship on the way
 * round.) Not while docked or landed: the ship is held on the pad or sits on its gear. The turn eases in fast and settles
 * precisely, then stays locked on it, tracking it as it moves, until you steer away yourself (or
 * the target goes, or you dock or land). The HUD says LOCKED while it holds. Through the periscope it's the easy way to centre something tiny.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { galPos } from './navigation';
import { turnThrust } from './resources';

/**
 * The turn has mass: it spins up at PIVOT_ACC, cruises at up to PIVOT_RATE, and brakes at PIVOT_ACC
 * to arrive at rest (the most it can turn at while still stopping in the angle left: √(2 α θ)).
 * It used to ease exponentially, fastest at the start: a ship with no mass, snapping round.
 * Measured: 10° 1.3 s, 45° 2.8 s, 90° 3.9 s, 150° 5.2 s.
 */
const PIVOT_ACC = 0.4, // rad/s²: ~23°/s² (1.2 at first felt no different from before on small turns)
  PIVOT_RATE = 0.8; // rad/s
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
  g.pivotRate = 0;
  g.pivotLocked = false;
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
  // (sun tracking turns the ship its own way: switching it on ends the pivot, and its lock)
  if (steered || !dir || g.ship.sunTrack || g.ship.ap?.phase === 'transfer' || g.jump || g.dock?.docked || g.ship.landed) {
    if (g.pivotLocked && steered) g.showMsg('Lock released');
    g.pivot = g.pivotLocked = false;
    g.pivotRate = 0;
    return;
  }
  const { ship } = g;
  // the shortest turn from the nose to the aim: about an axis across both, so no roll about the nose
  nose.set(0, 0, -1).applyQuaternion(ship.q);
  want.setFromUnitVectors(nose, dir).multiply(ship.q);
  const ang = ship.q.angleTo(want);
  if (ang < PIVOT_DONE) {
    // on it: stay locked, following it
    ship.q.copy(want);
    g.pivotRate = 0;
    if (!g.pivotLocked) {
      g.pivotLocked = true;
      g.showMsg(`Locked on ${g.target?.name ?? g.jumpDest?.name ?? 'the target'} · steer to break away`);
    }
    return;
  }
  // (zoomed in, the periscope's field is small: a slower, finer turn, as manual steering does)
  const k = 1 / Math.max(1, Math.sqrt(g.zoom.cur));
  const brake = Math.sqrt(2 * PIVOT_ACC * k * ang);
  const wantRate = Math.min(PIVOT_RATE * k, brake);
  const next = wantRate > g.pivotRate ? Math.min(wantRate, g.pivotRate + PIVOT_ACC * k * realDt) : wantRate;
  // spinning up and braking are the attitude thrusters' work: paid for, and only as far as they can
  g.pivotRate += (next - g.pivotRate) * turnThrust(g, Math.abs(next - g.pivotRate), realDt);
  const step = Math.min(ang, g.pivotRate * realDt);
  ship.q.rotateTowards(want, step).normalize();
}
