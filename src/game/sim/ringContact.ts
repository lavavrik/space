/*
 * Hitting the ring's rocks (docs/rings.md, "Collisions"). After the ship moves, its path over the
 * step is swept against the rocks around it (sim/ringRocks.ts, the same rocks the GPU draws).
 *
 *   - The ship's size is its cross-section along its motion through the rocks (sim/thermal.ts):
 *     ~6 m across nose-first, ~15 m side-on. Flying nose-first meets ~5× fewer rocks.
 *   - Damage is by the closing speed, scaled for the rock's mass (reduced mass: a pebble has to be
 *     fast to hurt, a boulder is like the ground), through sim/damage.ts.
 *   - A rock lighter than the ship is knocked aside: the ship keeps going, less the momentum it gave
 *     up, and that rock is spent (ignored) for SPENT_S. The rocks are drawn from a hash, so it can't
 *     actually move; without this the ship stopped against a 2 m pebble and hit it again and again.
 *   - A heavier one bounces the ship off (back to where it touched, BOUNCE of the closing speed).
 *   - A ring orbit's autopilot whose spot was taken steps the orbit aside.
 */
import { CRASH_SPEED } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { impact } from './damage';
import { frameVel } from './frame';
import { shipMass } from './resources';
import { RING_HALF_THICK } from './rings';
import { BOUNCE, ROCK_K, ROCK_SCRAPE, effectiveSpeed, rockMass, sweepRocks } from './ringRocks';
import { crossSection } from './thermal';

/** How long a knocked-aside rock is left out of the collisions (s). */
const SPENT_S = 120;

const a = new THREE.Vector3(),
  b = new THREE.Vector3(),
  vRel = new THREE.Vector3(),
  dir = new THREE.Vector3();

const spent = new WeakMap<Game, Map<string, number>>();

/** The ship's radius (m) across its motion `u` (unit): from its cross-section there. */
export const shipRadiusAlong = (g: Game, u: THREE.Vector3) => Math.sqrt(crossSection(g, u) / Math.PI);

/** After the ship's move this step (dt s): any rock in the way? */
export function ringContact(g: Game, dt: number) {
  const { ship } = g;
  const w = g.frameBody;
  if (w.kind === 'star' || !w.ring || ship.mode !== 'normal' || ship.dead || ship.landed || g.warp > 1 || dt <= 0) return;
  b.subVectors(ship.pos, w.pos);
  a.copy(b).addScaledVector(ship.vel, -dt);
  // cheap reject: nowhere near the belt's slab or span
  const ha = a.dot(w.axis),
    hb = b.dot(w.axis);
  const slab = RING_HALF_THICK + 1000;
  if ((ha > slab && hb > slab) || (ha < -slab && hb < -slab)) return;
  const rr = Math.sqrt(Math.max(0, b.lengthSq() - hb * hb)) / w.radius;
  if (rr < w.ring.inner - 0.01 || rr > w.ring.outer + 0.01) return;
  // the ship's size across its motion through the rocks around it
  dir.copy(ship.vel).sub(frameVel(g));
  const shipR = shipRadiusAlong(g, dir.lengthSq() > 1e-6 ? dir.normalize() : dir.set(0, 0, -1).applyQuaternion(ship.q));
  const sp = spent.get(g) ?? spent.set(g, new Map()).get(g)!;
  const hit = sweepRocks(w, a, b, dt, g.simTime, shipR, (id) => (sp.get(id) ?? -Infinity) > g.simTime);
  if (!hit) return;
  const { rock, normal } = hit;
  vRel.copy(ship.vel).sub(rock.vel);
  const vn = -vRel.dot(normal);
  if (vn <= 0) return;
  const R = rock.size * ROCK_K + shipR;
  const ms = shipMass(ship),
    mr = rockMass(rock.size);
  // damage, by the approach speed scaled for the rock's mass
  const size = rock.size < 10 ? rock.size.toFixed(1) : rock.size.toFixed(0);
  const h0 = ship.hull;
  if (impact(g, effectiveSpeed(vn, mr, ms), ROCK_SCRAPE, CRASH_SPEED, `a ${size} m rock`, w, vn)) return;
  // the ship's share of (1 + e) × the closing speed along the normal
  ship.vel.addScaledVector(normal, (1 + BOUNCE) * vn * (mr / (mr + ms)));
  if (mr < ms) {
    // knocked aside: the ship carries on; this rock is out of the way for a while
    sp.set(rock.id, g.simTime + SPENT_S);
    for (const [id, until] of sp) if (until < g.simTime) sp.delete(id);
  } else {
    // bounced off: back to where it touched (relative to the rock at the end of the step), just clear
    ship.pos.copy(w.pos).add(rock.pos).addScaledVector(normal, R + 0.05);
    if (ship.ap?.type === 'ring') {
      // the ring orbit's spot is taken by this rock: step the orbit aside, away from it
      const out = b.clone().addScaledVector(w.axis, -hb).normalize();
      ship.ap.r0 += (normal.dot(out) >= 0 ? 1 : -1) * 2 * R;
    }
  }
  if (ship.ap) ship.ap.settled = false;
  // a bump too gentle to damage still gets a word (not every frame of a scrape)
  const now = performance.now() / 1000,
    last = lastNote.get(g) ?? -Infinity;
  if (vn > 0.5 && ship.hull >= h0 - 0.01 && now - last > 3) {
    lastNote.set(g, now);
    g.showMsg(`${mr < ms ? 'Knocked aside' : 'Bumped'} a ${size} m rock at ${vn.toFixed(1)} m/s`, 'warn');
  }
}

const lastNote = new WeakMap<Game, number>();
