/*
 * Belt protection (docs/rings.md, "Protection"): what a ring's belt does to a ship besides the rocks
 * it can hit (sim/ringContact.ts), and the two modules against it (outfit/catalog.ts).
 *
 *   - Dust erosion: inside the belt's slab, faster than DUST_V through the rocks' frame, the hull
 *     wears: DUST_K × density × ((v − DUST_V) / 1 km/s)³ per second (the dust's kinetic energy
 *     flux goes as v³). Cruising at the belt limit (800 m/s) in a dense band: ~0.6 %/min; crossing
 *     the slab at 3 km/s: ~6 % for the one second it takes; at orbital speeds across it, fatal.
 *   - Magnetic deflector: turns aside most of that dust (its `block` share), drawing its power only
 *     while there's dust to stop.
 *   - Collision-warning radar: while you're in or near a belt, every SCAN_EVERY it looks ahead
 *     (its range, or GUARD_T seconds at your speed through the rocks) for rocks of its minimum size
 *     and up on a collision course: the nearest in time is the threat (Game.rockThreat), marked on
 *     the HUD and announced. The CR-5 also nudges you clear: while flight assist is on and you're
 *     not steering sideways (forward and back are fine), it pushes you sideways off the rock's line
 *     (across your motion, the short way) at NUDGE_ACC until it will miss by NUDGE_MARGIN.
 */
import { NORMAL_ACC } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { deflectorFitted, guardFitted } from '../outfit/catalog';
import type { World } from '../types';
import { hurt } from './damage';
import { frameVel } from './frame';
import { grant } from './power';
import { applyThrust } from './resources';
import { RING_HALF_THICK, ringDensity } from './rings';
import { ROCK_K, rockLabel, rockOn, rocksNear, type Rock } from './ringRocks';
import { shipRadiusAlong } from './ringContact';

/** Closing on a rock slower than this (m/s) isn't a threat: below the scrape speed, a bump. */
const MIN_CLOSING = 2;
export const DUST_V = 500,
  DUST_K = 0.004;
/** The collision radar: how often it looks, how far ahead in time at most, and the layers' search reach. */
const SCAN_EVERY = 0.25,
  GUARD_T = 30;
/** The pebble layer's cells are small: past this reach (m) it would be thousands of cells. */
const PEBBLE_REACH = 1500;
/** Nudging clear: the miss it aims for (m, beyond touching), and the most it pushes (m/s²). */
const NUDGE_MARGIN = 15,
  NUDGE_ACC = NORMAL_ACC * 0.5;

/** A rock on a collision course. Its place and velocity are as of `t0` (sim time; planet-centred). */
export interface RockThreat {
  id: string;
  size: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  t0: number;
  /** Seconds to contact, as of the scan. */
  tHit: number;
  /** Nudging clear (CR-5), or just warning. */
  avoiding: boolean;
}

/** A tracked rock now: where it is (planet-centred), how it moves, and seconds to its closest approach (≤ 0: passed). */
export function threatNow(g: Game, th: RockThreat, pos = new THREE.Vector3(), vel = new THREE.Vector3()) {
  const w = g.frameBody;
  rockOn(w.axis, th.pos, th.vel, g.simTime - th.t0, pos, vel);
  const rel = tmp3.subVectors(g.ship.pos, w.pos).sub(pos);
  const u = tmp4.copy(g.ship.vel).sub(vel);
  const uu = u.lengthSq();
  const t = uu > 1e-9 ? -rel.dot(u) / uu : 0;
  return { pos, vel, t, closing: Math.sqrt(uu) };
}
const tmp3 = new THREE.Vector3(),
  tmp4 = new THREE.Vector3();

/** Where the ship is against a ring's belt: its world, the density there, and whether it's inside the slab. */
function beltHere(g: Game): { w: World; dens: number; inSlab: boolean; near: boolean } | null {
  const w = g.frameBody;
  if (w.kind === 'star' || !w.ring) return null;
  const rel = tmp.subVectors(g.ship.pos, w.pos);
  const h = rel.dot(w.axis);
  const r = Math.sqrt(Math.max(0, rel.lengthSq() - h * h)) / w.radius;
  const near = Math.abs(h) < RING_HALF_THICK + 20e3 && r > w.ring.inner - 0.02 && r < w.ring.outer + 0.02;
  if (!near) return null;
  return { w, dens: ringDensity(w, r) / 0.85, inSlab: Math.abs(h) < RING_HALF_THICK, near };
}

/** The ship's velocity through the rocks where it is (their circular orbit), relative to the frame body. */
function rockFrameVel(w: World, g: Game, out: THREE.Vector3) {
  const rel = tmp2.subVectors(g.ship.pos, w.pos);
  rel.addScaledVector(w.axis, -rel.dot(w.axis));
  const r = rel.length();
  return out.crossVectors(w.axis, rel).multiplyScalar(Math.sqrt(w.mu / (r * r * r))).add(w.vel).sub(g.frameBody.vel);
}

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3(),
  vThrough = new THREE.Vector3();

/** Hull wear rate (per s) from the belt's dust at `v` m/s through it, density `dens` (0–1), before any deflector. */
export const dustRate = (v: number, dens: number) => (v <= DUST_V ? 0 : DUST_K * dens * ((v - DUST_V) / 1000) ** 3);

/** Each step, normal space: dust erosion and the deflector; the collision radar and its nudge. */
export function updateBelt(g: Game, dt: number, inputs: boolean) {
  const { ship, power } = g;
  g.erosion = 0;
  g.nudging = false;
  const here = ship.mode === 'normal' && !ship.dead && !g.dock?.docked && dt > 0 ? beltHere(g) : null;
  if (!here) {
    g.rockThreat = null;
    return;
  }
  const { w, dens, inSlab } = here;
  const v = vThrough.copy(ship.vel).sub(rockFrameVel(w, g, tmp)).length();
  // dust
  if (inSlab && g.warp <= 1) {
    let rate = dustRate(v, dens);
    const def = deflectorFitted(ship.outfit);
    if (rate > 0 && def && ship.breakers.shield) {
      const k = grant(g, def.caps.kw, 'deflector');
      power.shieldKW = k;
      rate *= 1 - def.caps.block * (k / def.caps.kw);
    }
    g.erosion = rate;
    if (rate > 0) hurt(g, rate * dt, `Worn through by ${w.name}'s ring dust at ${v.toFixed(0)} m/s`, w);
  }
  // collision radar
  const guard = guardFitted(ship.outfit);
  if (!guard || !ship.breakers.guard || g.warp > 1) {
    g.rockThreat = null;
    return;
  }
  const kw = grant(g, guard.caps.kw, 'collision radar');
  power.guardKW = kw;
  if (kw < guard.caps.kw * 0.5) {
    g.rockThreat = null;
    return;
  }
  const last = lastScan.get(g) ?? -Infinity;
  if (g.simTime - last >= SCAN_EVERY || g.simTime < last) {
    lastScan.set(g, g.simTime);
    const all = scan(g, w, guard.caps.minSize, guard.caps.range, guard.caps.avoid);
    // a rock tracked before stays tracked until it's passed, even if a scan misses it (the search
    // box shifts with your speed): dropping it for a scan let flight assist damp the nudge away
    const seen = new Set(all.map((t) => t.id));
    for (const th of threats.get(g) ?? []) {
      if (seen.has(th.id)) continue;
      const now = threatNow(g, th);
      if (now.t > 0 && now.closing > MIN_CLOSING) all.push(th);
    }
    all.sort((a, b) => threatNow(g, a).t - threatNow(g, b).t);
    threats.set(g, all);
    g.rockThreat = all[0] ?? null; // the soonest, for the HUD
    const th = g.rockThreat;
    // announced once per rock (a threat that drops out of a scan and back isn't news)
    const said = announced.get(g) ?? announced.set(g, new Map()).get(g)!;
    // (pebbles only get the marker and the pill while the radar steers you round them: at speed there
    // are too many to announce each)
    if (th && !(th.avoiding && th.size < 10) && !((said.get(th.id) ?? -Infinity) > g.simTime - 20)) {
      said.set(th.id, g.simTime);
      g.showMsg(`Collision warning · ${rockLabel(th.size)} rock in ${th.tHit.toFixed(1)} s${th.avoiding ? ' · steering clear' : ''}`, 'warn');
    }
  }
  // (not while you steer sideways yourself, nor while a computer flies)
  const list = threats.get(g) ?? [];
  if (guard.caps.avoid && list.length && ship.fa && !inputs && !ship.ap && !g.autodock && !g.ascent) nudge(g, w, list, dt);
}

const lastScan = new WeakMap<Game, number>();
const threats = new WeakMap<Game, RockThreat[]>();
const announced = new WeakMap<Game, Map<string, number>>();

/** The rocks on a collision course, of those `minSize` and up within `range` ahead: soonest first. */
function scan(g: Game, w: World, minSize: number, range: number, avoid: boolean): RockThreat[] {
  const { ship } = g;
  const p = tmp.subVectors(ship.pos, w.pos).clone();
  const through = ship.vel.clone().sub(frameVel(g));
  const speed = through.length();
  const shipR = shipRadiusAlong(g, speed > 1e-3 ? through.clone().normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q));
  const found: RockThreat[] = [];
  const list: Rock[] = [];
  for (let layer = 0; layer < 3; layer++) {
    list.length = 0;
    const reach = Math.min(layer === 0 ? PEBBLE_REACH : range, Math.max(speed * GUARD_T, 300));
    // the stretch of the belt ahead of you (in the rocks' frame they barely move)
    const ahead = p.clone().addScaledVector(through, speed > 1e-3 ? reach / speed : 0);
    if (!rocksNear(w, layer, p, ahead, shipR + 50, g.simTime, list)) continue;
    for (const rock of list) {
      if (rock.size < minSize) continue;
      const rel = p.clone().sub(rock.pos),
        u = ship.vel.clone().sub(rock.vel);
      const uu = u.lengthSq();
      // (drifting into one slower than this is a harmless bump: ringContact takes care of it)
      if (uu < MIN_CLOSING * MIN_CLOSING) continue;
      const t = -rel.dot(u) / uu;
      if (t <= 0 || t > GUARD_T) continue;
      const miss = rel.addScaledVector(u, t).length();
      // (tracked out to twice the margin, so a rock already nudged clear stays watched till it's passed)
      if (miss > rock.size * ROCK_K + shipR + NUDGE_MARGIN * 2) continue;
      found.push({ id: rock.id, size: rock.size, pos: rock.pos.clone(), vel: rock.vel.clone(), t0: g.simTime, tHit: t, avoiding: avoid });
    }
  }
  return found.sort((a, b) => a.tHit - b.tHit);
}

/**
 * Push the ship sideways off every threat's line: each pulls toward its own way clear (the short way,
 * across the relative motion), weighted by how far short it is and how soon, and the ship is pushed at
 * NUDGE_ACC along the sum until each will miss by NUDGE_MARGIN. (Dodging one rock at a time, it
 * dodged a pebble straight into the boulder behind it.)
 */
function nudge(g: Game, w: World, list: RockThreat[], dt: number) {
  const { ship } = g;
  const sum = new THREE.Vector3();
  let pending = false;
  for (const th of list) {
    const now = threatNow(g, th);
    const rel = tmp.subVectors(ship.pos, w.pos).sub(now.pos);
    const u = ship.vel.clone().sub(now.vel);
    const t = now.t;
    if (t <= 0 || now.closing < MIN_CLOSING) continue; // passed it, or only drifting
    pending = true;
    const off = rel.clone().addScaledVector(u, t); // where it passes, relative to the rock
    const need = th.size * ROCK_K + shipRadiusAlong(g, u.clone().normalize()) + NUDGE_MARGIN - off.length();
    if (need <= 0) continue;
    let dir = off.lengthSq() > 1e-6 ? off.normalize() : new THREE.Vector3().crossVectors(u, w.axis).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
    sum.addScaledVector(dir, need / Math.max(t, 0.1));
  }
  // Flight assist leaves the sideways drift alone until the rocks are passed: the miss comes from
  // that drift, and damping it away right after the push (as it did) put the ship back on course
  // for the rock.
  if (pending) g.nudging = true;
  if (sum.lengthSq() < 1e-9) return;
  // full push until the predicted misses are enough: the prediction assumes a steady velocity, and a
  // pilot holding thrust closes faster than it says (a push sized to the time left fell short)
  const T = sum.normalize().multiplyScalar(NUDGE_ACC * dt);
  applyThrust(g, T, dt);
  ship.vel.add(T);
}
