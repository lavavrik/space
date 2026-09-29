/*
 * The mining laser (docs/rings.md, "Mining"; module in outfit/catalog.ts). Shift+M turns it on and
 * off. On, it fires along the nose: the first rock of a ring's belt in its path within range is hit
 * (the same rocks as drawn: sim/ringRocks.ts), its ice boils off, and the fuel scoop catches the
 * vapour, which is cracked into propellant.
 *
 *   - Yield: YIELD_PER_MW × the beam's power (what the bus grants of it) × the rock's ice fraction ×
 *     the range factor (full out to a third of the range, falling to none at it). Tuned to be worth
 *     it (the ML-6 at close range fills an empty tank in ~6 minutes), not from the physics: really
 *     6 MW would boil ~2 kg/s.
 *   - It needs a fuel scoop to catch the vapour, and you close to the rock (under HOLD_V relative
 *     to it) or the plume streams past.
 *   - Its draw is a load on the bus like any other (MINING LASER), from the battery beyond what the
 *     panels give, and like every load it ends up as heat in the hull.
 *   - What a rock is made of comes from its id (a hash, like everything else about it): a giant's
 *     ring rocks are 90–99 % water ice, the rest silicate grit and a trace of metal. (Metals are for
 *     later, with a hold and an economy: SPACE-51.)
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { laserFitted, scoopFitted } from '../outfit/catalog';
import { grant } from './power';
import { RING_HALF_THICK } from './rings';
import { COLLIDE_LAYERS, ROCK_K, rockLabel, rocksNear, type Rock } from './ringRocks';

/** Propellant per MW of beam on pure ice at close range (kg/s). */
const YIELD_PER_MW = 60;
/** Faster than this against the rock (m/s), the scoop can't catch the plume. */
const HOLD_V = 50;

/** What the beam is doing this step (for the HUD, the renderer and the scoop). */
export interface LaserState {
  on: boolean;
  /** The beam's end: the rock it hits, or out at its range (planet-centred, or null outside a belt). */
  end: THREE.Vector3 | null;
  hit: { id: string; size: number; ice: number; normal: THREE.Vector3; dist: number } | null;
  /** Propellant it's yielding (kg/s), and why none if none. */
  rate: number;
  why: string;
}

export const laserOff = (): LaserState => ({ on: false, end: null, hit: null, rate: 0, why: '' });

/** A rock's water ice fraction from its id (a hash): 0.90–0.99 in a giant's rings. */
export function rockIce(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return 0.9 + 0.09 * ((h % 10007) / 10007);
}

/** Shift+M. */
export function toggleLaser(g: Game) {
  const unit = laserFitted(g.ship.outfit);
  if (!unit) {
    g.showMsg('No mining laser fitted · fit one at a station (Shift+U)', 'warn');
    return;
  }
  g.laser.on = !g.laser.on;
  g.showMsg(g.laser.on ? `${unit.model} ${unit.name} on · aim the nose at a rock` : 'Mining laser off');
}

const nose = new THREE.Vector3(),
  toRock = new THREE.Vector3();

/** Each step (normal space): fire the beam, find what it hits, and what that yields. */
export function updateLaser(g: Game) {
  const { ship, power } = g;
  const L = g.laser;
  L.end = null;
  L.hit = null;
  L.rate = 0;
  L.why = '';
  power.laserKW = 0;
  const unit = laserFitted(ship.outfit);
  if (!L.on || !unit) return;
  if (ship.mode !== 'normal' || ship.dead || g.dock?.docked || g.inStation) {
    L.why = 'not here';
    return;
  }
  const kw = grant(g, unit.caps.kw, 'mining laser');
  power.laserKW = kw;
  const w = g.frameBody;
  const from = ship.pos.clone().sub(w.pos);
  nose.set(0, 0, -1).applyQuaternion(ship.q);
  L.end = from.clone().addScaledVector(nose, unit.caps.range);
  if (kw < 1) {
    L.why = 'no power';
    return;
  }
  if (w.kind === 'star' || !w.ring) {
    L.why = 'no ring here';
    return;
  }
  // the nearest rock along the beam
  const h0 = from.dot(w.axis),
    h1 = L.end.dot(w.axis);
  if (Math.min(h0, h1) > RING_HALF_THICK + 600 || Math.max(h0, h1) < -RING_HALF_THICK - 600) {
    L.why = 'no rock in the beam';
    return;
  }
  let best: { rock: Rock; t: number } | null = null;
  const list: Rock[] = [];
  for (let layer = 0; layer < COLLIDE_LAYERS; layer++) {
    list.length = 0;
    if (!rocksNear(w, layer, from, L.end, 0, g.simTime, list)) continue;
    for (const rock of list) {
      // ray against the rock's sphere
      const R = rock.size * ROCK_K;
      toRock.subVectors(rock.pos, from);
      const along = toRock.dot(nose);
      if (along < 0 || along > unit.caps.range + R) continue;
      const d2 = toRock.lengthSq() - along * along;
      if (d2 > R * R) continue;
      const t = along - Math.sqrt(R * R - d2);
      if (t < 0 || t > unit.caps.range || (best && t >= best.t)) continue;
      best = { rock, t };
    }
  }
  if (!best) {
    L.why = 'no rock in the beam';
    return;
  }
  const { rock, t } = best;
  const at = from.clone().addScaledVector(nose, t);
  L.end = at;
  const ice = rockIce(rock.id);
  L.hit = { id: rock.id, size: rock.size, ice, normal: at.clone().sub(rock.pos).normalize(), dist: t };
  if (!scoopFitted(ship.outfit)) {
    L.why = 'no fuel scoop to catch the vapour';
    return;
  }
  const vRel = ship.vel.clone().add(g.frameBody.vel).sub(w.vel).sub(rock.vel).length();
  if (vRel > HOLD_V) {
    L.why = `too fast past it (${vRel.toFixed(0)} m/s) · the plume streams past`;
    return;
  }
  const r = unit.caps.range;
  const far = t < r / 3 ? 1 : Math.max(0, (r - t) / (r * (2 / 3)));
  L.rate = YIELD_PER_MW * (kw / 1000) * ice * far;
  if (L.rate <= 0) L.why = 'out of range';
}

/** For the scoop (sim/resources.ts): what the laser yields this step. */
export function laserYield(g: Game) {
  const L = g.laser;
  if (!L.hit || L.rate <= 0) return null;
  return { rate: L.rate, what: `Laser mining a ${rockLabel(L.hit.size)} rock · ${Math.round(L.hit.ice * 100)} % ice` };
}
