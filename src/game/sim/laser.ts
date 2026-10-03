/*
 * The mining laser (docs/rings.md, "Mining"; module in outfit/catalog.ts). Shift+M turns it on and
 * off. On, it fires along the nose: the first rock of a ring's belt in its path within range is hit
 * (the same rocks as drawn: sim/ringRocks.ts), its ice boils off, and the fuel scoop catches the
 * vapour, which is cracked into propellant.
 *
 *   - Yield: YIELD_PER_MW × the beam's power (what the bus grants of it) × the rock's ice fraction ×
 *     the range factor (full out to a third of the range, falling to none at it). Tuned to be worth
 *     it (the ML-6 at close range fills an empty tank in ~6 minutes), not from the physics: really
 *     600 kW would boil ~0.2 kg/s.
 *   - It needs a fuel scoop to catch the vapour, and you close to the rock (under HOLD_V relative
 *     to it) or the plume streams past.
 *   - Its draw is a load on the bus like any other (MINING LASER), from the battery beyond what the
 *     panels give, and like every load it ends up as heat in the hull.
 *   - What a rock is made of comes from its id (a hash, like everything else about it): a giant's
 *     ring rocks are 90–99 % water ice, the rest silicate grit and a trace of metal; one in 33 is
 *     metal-rich, and what metal varies rock to rock (rockMake).
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { laserFitted, scoopFitted } from '../outfit/catalog';
import { grant } from './power';
import { stowMetal, type Commodity } from './economy';
import { RING_HALF_THICK } from './rings';
import type { World } from '../types';
import { COLLIDE_LAYERS, METAL_RICH, minedKey, minedRocks, rockLabel, rockMass, rockRay, rocksNear, type Rock } from './ringRocks';
import { swarmHere, swarmRay, swarmRocks, type SwarmRock } from './swarm';

/** Propellant per MW of beam on pure ice at close range (kg/s). */
export const YIELD_PER_MW = 600;
/** Faster than this against the rock (m/s), the scoop can't catch the plume. */
const HOLD_V = 50;

/** What the beam is doing this step (for the HUD, the renderer and the scoop). */
export interface LaserState {
  on: boolean;
  /** The beam's end: the rock it hits, or out at its range (planet-centred, or null outside a belt). */
  end: THREE.Vector3 | null;
  hit: { id: string; /** Its key in `minedRocks` when it isn't a ring's (a swarm's rock). */ key?: string; size: number; size0: number; make: RockMake; center: THREE.Vector3; normal: THREE.Vector3; dist: number } | null;
  /** Propellant it's yielding (kg/s), and why none if none. */
  rate: number;
  /** Rock the beam breaks up and scatters (kg/s), and metal the scoop catches from it (kg/s). */
  removal: number;
  metal: number;
  why: string;
  /** Sim time the beam last hit a rock (or it was switched on): LASER_IDLE after, with nothing hit, it switches off. */
  lastHit: number;
  /** Sim time of the last step it fired (updateLaser runs only in normal flight: `hit` is stale otherwise). */
  firedAt: number;
}

/**
 * On and hitting nothing for this long (s), the laser switches itself off. That also covers a rock
 * mined away: the beam carries on into one right behind it if there is one (it used to switch off
 * the moment its rock was gone), else it goes off this long after.
 */
export const LASER_IDLE = 3;

export const laserOff = (): LaserState => ({ on: false, end: null, hit: null, rate: 0, removal: 0, metal: 0, why: '', lastHit: -Infinity, firedAt: -Infinity });

function idHash(id: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/** A rock's water ice fraction from its id (a hash): 0.90–0.99 in a giant's rings. */
export const rockIce = (id: string) => 0.9 + 0.09 * idHash(id, 0);

/**
 * What a rock is made of (fractions): water ice, and the rest silicate grit and metal; and what its
 * metal is (`mix`, fractions of the metal). `kind` names the metal-rich ones.
 */
export interface RockMake {
  ice: number;
  rock: number;
  metal: number;
  mix: Record<Commodity, number>;
  kind: 'icy' | 'rocky' | 'nickel-iron' | 'cobalt-rich' | 'platinum-rich';
}

/**
 * A rock's make-up, from its id and tint draw (hashes, like everything else about it).
 *
 *   - Icy (most): 90–99 % water ice, a trace of metal: mostly nickel-iron, 3–12 % cobalt,
 *     0.2–1.2 % platinum-group. About 0.2 Cr per kg of metal.
 *   - Metal-rich (one in 33, tint under METAL_RICH: drawn darker and glinting): a rock that fell in,
 *     or a moonlet's core; 5–30 % ice, 25–55 % metal, of three kinds:
 *       nickel-iron (60 %): ~95 % nickel-iron, a little cobalt, ~0.1–0.2 Cr/kg;
 *       cobalt-rich (30 %): 20–35 % cobalt, ~0.4 Cr/kg;
 *       platinum-rich (10 %): 4–12 % platinum-group metals, ~0.5–1.4 Cr/kg: the find.
 */
export function rockMake(r: { id: string; tint: number }): RockMake {
  const { id } = r;
  const h = (salt: number) => idHash(id, salt);
  if (id.startsWith('T:')) return trojanMake(r, h);
  const mix = (cobalt: number, pgm: number) => ({ nife: 1 - cobalt - pgm, cobalt, pgm });
  if (r.tint < METAL_RICH) {
    const ice = 0.05 + 0.25 * h(5),
      metal = 0.25 + 0.3 * h(7);
    const k = h(11);
    const [kind, m] =
      k < 0.6 ? (['nickel-iron', mix(0.02 + 0.04 * h(13), 0.002 + 0.006 * h(17))] as const)
      : k < 0.9 ? (['cobalt-rich', mix(0.2 + 0.15 * h(13), 0.004 + 0.01 * h(17))] as const)
      : (['platinum-rich', mix(0.05 + 0.1 * h(13), 0.04 + 0.08 * h(17))] as const);
    return { ice, rock: 1 - ice - metal, metal, mix: m, kind };
  }
  const ice = rockIce(id);
  const metal = (1 - ice) * (0.05 + 0.25 * h(7));
  return { ice, rock: 1 - ice - metal, metal, mix: mix(0.03 + 0.09 * h(13), 0.002 + 0.01 * h(17)), kind: 'icy' };
}
/**
 * A trojan swarm's rock (sim/swarm.ts, ids `T:…`): dry, dark rock from the giant's formation, not
 * ring ice. Most are 8–28 % metal (the same mix as ring rocks' metal: mostly nickel-iron, 3–12 %
 * cobalt, ~1 % platinum-group) with 0–12 % ice; one in 12 (tint under TROJAN_METAL_RICH) is a metal
 * core, 40–65 % metal of three kinds: nickel-iron 50 %, cobalt-rich 30 %, platinum-rich 20 %. About
 * ten times the metal of a ring rock, and a fraction of the propellant.
 */
export const TROJAN_METAL_RICH = 0.08;
function trojanMake(r: { id: string; tint: number }, h: (salt: number) => number): RockMake {
  const mix = (cobalt: number, pgm: number) => ({ nife: 1 - cobalt - pgm, cobalt, pgm });
  if (r.tint < TROJAN_METAL_RICH) {
    const ice = 0.05 * h(5),
      metal = 0.4 + 0.25 * h(7);
    const k = h(11);
    const [kind, m] =
      k < 0.5 ? (['nickel-iron', mix(0.02 + 0.04 * h(13), 0.002 + 0.006 * h(17))] as const)
      : k < 0.8 ? (['cobalt-rich', mix(0.2 + 0.15 * h(13), 0.004 + 0.01 * h(17))] as const)
      : (['platinum-rich', mix(0.05 + 0.1 * h(13), 0.04 + 0.08 * h(17))] as const);
    return { ice, rock: 1 - ice - metal, metal, mix: m, kind };
  }
  const ice = 0.12 * h(0),
    metal = 0.08 + 0.2 * h(7);
  return { ice, rock: 1 - ice - metal, metal, mix: mix(0.03 + 0.09 * h(13), 0.002 + 0.01 * h(17)), kind: 'rocky' };
}

/**
 * Metal the scoop's magnetic separator catches, per kg of rock the beam breaks up and scatters (most
 * of the grains fly off): ~0.7 kg/s from an ice rock under the ML-6, ~30 from a metal-rich one.
 */
export const METAL_CATCH = 1e-4;

/**
 * Rock the beam breaks up and scatters, per kg of ice-equivalent it frees (what a pure-ice rock would
 * give the scoop): most of it is lost. Sized so a big rock lasts about a tank: ~100 m across, ~8 minutes under the ML-6;
 * a 20 m one, seconds; pebbles, a blink. Below GONE of its size it's gone.
 */
export const DISPERSE = 2000,
  /** (a mined rock's size below which it's gone) */
  GONE = 0.12;

/** Shift+M. */
export function toggleLaser(g: Game) {
  const unit = laserFitted(g.ship.outfit);
  if (!unit) {
    g.showMsg('No mining laser fitted · fit one at a station (Shift+U)', 'warn');
    return;
  }
  g.laser.on = !g.laser.on;
  g.laser.lastHit = g.simTime;
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
  L.rate = L.removal = L.metal = 0;
  L.why = '';
  L.firedAt = g.simTime;
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
  const ringed = w.kind !== 'star' && !!w.ring;
  const swarm = ringed ? null : swarmHere(g.cur, ship, w);
  if (!ringed && !swarm) {
    L.why = 'no ring or swarm here';
    return;
  }
  // the nearest rock along the beam
  const best: { rock: Rock | null; t: number } = { rock: null, t: Infinity };
  const consider = (rock: Rock, ray: (r: Rock, f: THREE.Vector3, d: THREE.Vector3, m: number) => number | null) => {
    // quick reject by its bounding sphere, then against the shape it's drawn with
    const R = rock.size * 1.5;
    toRock.subVectors(rock.pos, from);
    const along = toRock.dot(nose);
    if (along < -R || along > unit.caps.range + R) return;
    if (toRock.lengthSq() - along * along > R * R) return;
    const t = ray(rock, from, nose, Math.min(best.t, unit.caps.range));
    if (t === null || t >= best.t) return;
    best.rock = rock;
    best.t = t;
  };
  if (swarm) {
    const list: SwarmRock[] = [];
    const a = ship.pos.clone(),
      b = ship.pos.clone().addScaledVector(nose, unit.caps.range);
    swarmRocks(swarm.field, swarm.centre, a, b, 0, w.pos, w.vel, list, undefined, (k) => minedRocks.get(k));
    for (const rock of list) consider(rock, swarmRay);
  } else {
    const h0 = from.dot(w.axis),
      h1 = L.end.dot(w.axis);
    if (Math.min(h0, h1) > RING_HALF_THICK + 600 || Math.max(h0, h1) < -RING_HALF_THICK - 600) {
      L.why = 'no rock in the beam';
      return;
    }
    const list: Rock[] = [];
    for (let layer = 0; layer < COLLIDE_LAYERS; layer++) {
      list.length = 0;
      if (!rocksNear(w as World, layer, from, L.end, 0, g.simTime, list)) continue;
      for (const rock of list) consider(rock, rockRay);
    }
  }
  if (!best.rock) {
    L.why = 'no rock in the beam';
    return;
  }
  const rock = best.rock,
    t = best.t;
  const at = from.clone().addScaledVector(nose, t);
  L.end = at;
  const make = rockMake(rock);
  L.hit = { id: rock.id, key: (rock as SwarmRock).key, size: rock.size, size0: rock.size0, make, center: rock.pos.clone(), normal: at.clone().sub(rock.pos).normalize(), dist: t };
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
  // the rock broken up goes by the beam's power and range; the ice in it comes off as propellant,
  // and a little of its metal is caught
  const freed = YIELD_PER_MW * (kw / 1000) * far;
  L.removal = freed * DISPERSE;
  L.rate = freed * make.ice;
  L.metal = L.removal * make.metal * METAL_CATCH;
  if (freed <= 0) L.why = 'out of range';
}

/**
 * Each step, after the scoop took the yield (dt s): the metal caught goes in the hold; the rock loses
 * what the beam broke off, and shrinks (its size goes as the cube root of its mass); mined away below
 * GONE of its size.
 */
export function mineRock(g: Game, dt: number) {
  const L = g.laser;
  if (!L.hit || L.removal <= 0 || dt <= 0) return;
  // metal into the hold, as far as it goes
  if (L.metal > 0) {
    const took = stowMetal(g, L.metal * dt, L.hit.make.mix);
    if (took < L.metal * dt * 0.5 && !g.warned.holdFull) {
      g.warned.holdFull = true;
      g.showMsg('The hold is full · sell the metal at a station', 'warn');
    }
  }
  const w = g.frameBody;
  const key = L.hit.key ?? minedKey(w, L.hit.id);
  const left = minedRocks.get(key) ?? 1;
  const m0 = rockMass(L.hit.size0);
  const f = Math.max(0, left ** 3 - (L.removal * dt) / m0);
  const next = Math.cbrt(f);
  if (next < GONE) {
    minedRocks.set(key, 0);
    // the beam carries on: into the next rock behind it, or off LASER_IDLE later (laserIdle)
    g.showMsg(`The ${rockLabel(L.hit.size0)} rock is mined away`);
  } else minedRocks.set(key, next);
}

/** Each step: switch the laser off once it has hit nothing for LASER_IDLE (whatever the ship is doing). */
export function laserIdle(g: Game) {
  const L = g.laser;
  if (L.firedAt !== g.simTime) L.hit = null; // not fired this step (docked, in FTL, under warp…): nothing hit
  if (L.hit) L.lastHit = g.simTime;
  else if (L.on && g.simTime - L.lastHit > LASER_IDLE) {
    L.on = false;
    g.power.laserKW = 0;
    g.showMsg(`Mining laser off · nothing in the beam for ${LASER_IDLE} s`);
  }
}

/** For the scoop (sim/resources.ts): what the laser yields this step. */
export function laserYield(g: Game) {
  const L = g.laser;
  if (!L.hit || L.rate <= 0) return null;
  return { rate: L.rate, what: `Laser mining a ${rockLabel(L.hit.size)} rock · ${Math.round(L.hit.make.ice * 100)} % ice` };
}
