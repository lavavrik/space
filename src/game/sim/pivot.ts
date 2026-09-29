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
/**
 * Close enough to lock (rad): 0.1°. From there it follows the target exactly. (Waiting to be within
 * 1″ never happened with a moving target: the braking turn always arrives where it was, a little
 * behind where it is.) Through the periscope, the same share of the field: ÷ the magnification.
 */
const PIVOT_LOCK = 2e-3;

const want = new THREE.Quaternion(),
  nose = new THREE.Vector3(),
  ff = new THREE.Quaternion(),
  ffGot = new THREE.Quaternion(),
  ID = new THREE.Quaternion(),
  omega = new THREE.Vector3();

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
  g.pivotPrevDir = null;
  g.lockOmega.set(0, 0, 0);
  g.ship.sunTrack = false; // it would turn the ship back toward the star
}

/**
 * Unit direction from the ship to what we're pivoting to (world), or null. For a target, where it
 * will be relative to the ship at the end of this step (`dt` s on): the ship turns before anything
 * moves, and aiming at where it was left the nose a frame behind (~80″ on a station crossing the sky).
 */
function aimDir(g: Game, dt: number) {
  const t = g.target;
  if (t) {
    const at = t.pos.clone().addScaledVector(t.vel, dt);
    const me = g.ship.pos.clone().addScaledVector(g.ship.vel, dt).addScaledVector(g.frameBody.vel, dt);
    return at.sub(me).normalize();
  }
  if (g.jumpDest) return g.jumpDest.pos.clone().sub(galPos(g)).normalize(); // stars: direction only
  return null;
}

/** Each frame (real time), after manual steering: turn toward the aim point. */
export function updatePivot(g: Game, realDt: number, steered: boolean) {
  if (!g.pivot) return;
  const dir = aimDir(g, realDt * g.warp);
  // (sun tracking turns the ship its own way: switching it on ends the pivot, and its lock)
  if (steered || !dir || g.ship.sunTrack || g.ship.ap?.phase === 'transfer' || g.jump || g.dock?.docked || g.ship.landed) {
    if (g.pivotLocked && steered) g.showMsg('Lock released');
    g.pivot = g.pivotLocked = false;
    g.pivotRate = 0;
    g.pivotPrevDir = null;
    g.lockOmega.set(0, 0, 0);
    return;
  }
  const { ship } = g;
  const k = 1 / Math.max(1, Math.sqrt(g.zoom.cur));
  // Follow the target's own motion across the sky (feed-forward: the turn from where it was last
  // frame to where it is), then close what's left with the braking turn below. Without it, the
  // braking turn always arrived where a moving target had been, and through the periscope it never
  // caught up. The follow turn is the attitude thrusters' work too: what it costs is the change in its
  // rate (a target drifting steadily across the sky needs a steady turn: next to nothing).
  if (g.pivotPrevDir && realDt > 0) {
    ff.setFromUnitVectors(g.pivotPrevDir, dir);
    const s2 = Math.sqrt(Math.max(0, 1 - ff.w * ff.w));
    const a = 2 * Math.acos(Math.min(1, ff.w));
    omega.set(ff.x, ff.y, ff.z).multiplyScalar(s2 > 1e-12 ? a / s2 / realDt : 0);
    if (omega.length() < PIVOT_RATE * 2) {
      const got = turnThrust(g, omega.distanceTo(g.lockOmega), realDt);
      g.lockOmega.lerp(omega, got);
      ship.q.premultiply(ffGot.slerpQuaternions(ID, ff, got)).normalize();
    }
  }
  g.pivotPrevDir = (g.pivotPrevDir ?? new THREE.Vector3()).copy(dir);
  // the shortest turn from the nose to the aim: about an axis across both, so no roll about the nose
  nose.set(0, 0, -1).applyQuaternion(ship.q);
  want.setFromUnitVectors(nose, dir).multiply(ship.q);
  const ang = ship.q.angleTo(want);
  if (g.pivotLocked) {
    // locked: take up the last of it (what the follow turn left: a hair)
    if (ang < PIVOT_LOCK * k * 3) {
      ship.q.copy(want);
      return;
    }
    g.pivotLocked = false; // it jumped (a new target, say): turn onto it again
  }
  if (ang < PIVOT_LOCK * k) {
    // on it: lock, and follow it from now on
    ship.q.copy(want);
    g.pivotRate = 0;
    g.pivotLocked = true;
    g.showMsg(`Locked on ${g.target?.name ?? g.jumpDest?.name ?? 'the target'} · steer to break away`);
    return;
  }
  // (zoomed in, the periscope's field is small: a slower, finer turn, as manual steering does: k)
  const brake = Math.sqrt(2 * PIVOT_ACC * k * ang);
  const wantRate = Math.min(PIVOT_RATE * k, brake);
  const next = wantRate > g.pivotRate ? Math.min(wantRate, g.pivotRate + PIVOT_ACC * k * realDt) : wantRate;
  // spinning up and braking are the attitude thrusters' work: paid for, and only as far as they can
  g.pivotRate += (next - g.pivotRate) * turnThrust(g, Math.abs(next - g.pivotRate), realDt);
  const step = Math.min(ang, g.pivotRate * realDt);
  ship.q.rotateTowards(want, step).normalize();
}
