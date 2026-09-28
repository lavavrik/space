/*
 * Traffic (docs/traffic.md): other ships going about their business in the system. They don't use
 * the physics the player does; each follows a scripted, kinematic cycle between destinations
 * (stations and worlds):
 *
 *   linger — hang off a station or circle a world in a low orbit for a while
 *   depart — pull away toward the next destination, speeding up (normal space)
 *   ftl    — cross to it in FTL: speed eases up and back down over the leg, a trail streaming behind
 *            the ship (TRAIL_S seconds of travel at its current speed, up to TRAIL_MAX), with a flash
 *            as it enters and leaves FTL
 *   arrive — slow from the drop point into the linger spot at the destination
 *
 * Everything is worked out from the sim clock and the bodies' current positions, so time warp just
 * runs it faster. Ships don't collide, dock or interact yet.
 */
import type { Game } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Npc, Station } from '../types';

export type { Npc };
/** Where ships go. */
type Dest = Body | Station;
import { dropAlt } from './ftl';
import { minOrbitAlt } from './orbits';


/**
 * FTL trail: as long as TRAIL_S seconds of travel at the ship's current speed, up to TRAIL_MAX (m).
 * It grows and shrinks with the speed, easing at TRAIL_EASE (1/s), so it pulls in after drop-out.
 */
export const TRAIL_S = 30,
  TRAIL_MAX = 0.5 * 1.495978707e11,
  TRAIL_EASE = 1.5;
/** How long an FTL flash lasts (s). */
export const FLASH_S = 0.8;
/** A ship's size for the radar, scanner and clicks (m): half its ~60 m length. */
const SHIP_R = 30;
/** Seconds departing and arriving, and the acceleration then (m/s²). */
const MANEUVER_S = 12,
  MANEUVER_ACC = 150;


const KINDS = ['Freighter', 'Courier', 'Tanker', 'Survey ship', 'Hauler', 'Liner'];
const NAMES = ['Kestrel', 'Meridian', 'Halcyon', 'Ostrava', 'Tamsin', 'Blue Heron', 'Corvid', 'Anselm', 'Petrel', 'Lodestar', 'Varuna', 'Ilse', 'Marrow', 'Sable', 'Quillon', 'Juniper'];

/** Places ships go: stations and worlds with a surface to orbit (not stars). */
const destinations = (cur: CurrentSystem): Dest[] => [...cur.stations, ...cur.bodies.filter((b) => b.kind !== 'star')];

/** The ships in a system: a few, more with more stations. Deterministic per system. */
export function spawnTraffic(cur: CurrentSystem): Npc[] {
  const dests = destinations(cur);
  if (dests.length < 2) return [];
  const g = mulberry32(cur.sys.seed * 7 + 11);
  const n = Math.min(12, 3 + cur.stations.length * 2);
  const out: Npc[] = [];
  const names = [...NAMES];
  for (let i = 0; i < n; i++) {
    const at = dests[Math.floor(g() * dests.length)];
    const npc: Npc = {
      kind: 'ship',
      radius: SHIP_R,
      name: names.splice(Math.floor(g() * names.length), 1)[0], // each name once per system
      cls: KINDS[Math.floor(g() * KINDS.length)],
      seed: g() * 1000,
      at,
      to: null,
      phase: 'linger',
      t: g() * 60, // spread out when they leave
      dur: rr(g, 20, 120),
      off: new THREE.Vector3(),
      spin: 0,
      p0: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      trailL: 0,
      trailDir: new THREE.Vector3(0, 0, 1),
      flashAt: -Infinity,
    };
    lingerAt(npc, at, g);
    out.push(npc);
  }
  return out;
}

/** A linger spot at `b`: a few km off a station, or a low circular orbit round a world. */
function lingerAt(npc: Npc, b: Dest, g: () => number) {
  const dir = new THREE.Vector3(g() - 0.5, (g() - 0.5) * 0.4, g() - 0.5).normalize();
  if (b.kind === 'station') {
    npc.off.copy(dir).multiplyScalar(rr(g, 2e3, 6e3));
    npc.spin = 0;
  } else {
    const r = b.radius + minOrbitAlt(b) * rr(g, 1.2, 2.5);
    npc.off.copy(dir).multiplyScalar(r);
    npc.spin = Math.sqrt(b.mu / (r * r * r)); // a real circular orbit's rate
  }
}

/** How long an FTL leg of `dist` metres takes (s): ~20 s next door, ~2 min across an AU. */
const ftlTime = (dist: number) => 20 + 25 * Math.log10(1 + dist / 1e7);

/** Where a ship drops out of FTL near `b`: outside its FTL limit, on the side it's coming from. */
function dropPoint(b: Dest, from: THREE.Vector3, out: THREE.Vector3) {
  const r = b.kind === 'station' ? 60e3 : b.radius + dropAlt(b) * 1.3;
  return out.subVectors(from, b.pos).normalize().multiplyScalar(r).add(b.pos);
}

const tmp = new THREE.Vector3(),
  prev = new THREE.Vector3(),
  AXIS = new THREE.Vector3(0, 1, 0);

/** The linger spot's current world position (it circles a world at orbital rate). */
function lingerPos(npc: Npc, b: Dest, time: number, out: THREE.Vector3) {
  return out.copy(npc.off).applyAxisAngle(AXIS, npc.spin * time).add(b.pos);
}

/** Advance every ship to the current sim time (dt: this step, s). */
export function updateTraffic(g: Game, dt: number) {
  const time = g.simTime;
  const dests = destinations(g.cur);
  for (const npc of g.traffic) {
    prev.copy(npc.pos);
    npc.t += dt;
    if (npc.t >= npc.dur) nextPhase(npc, dests, time);
    const u = Math.min(1, npc.t / npc.dur);
    switch (npc.phase) {
      case 'linger':
        lingerPos(npc, npc.at, time, npc.pos);
        break;
      case 'depart': {
        // speeding up away from the linger spot toward the destination
        const dir = tmp.subVectors(npc.to!.pos, npc.p0).normalize();
        npc.pos.copy(npc.p0).addScaledVector(dir, 0.5 * MANEUVER_ACC * npc.t * npc.t);
        break;
      }
      case 'ftl': {
        // eased along the line from where FTL began to the (moving) drop point
        const end = dropPoint(npc.to!, npc.p0, tmp);
        const s = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: speed eases in and out
        npc.pos.copy(npc.p0).lerp(end, s);
        break;
      }
      case 'arrive': {
        // slowing from the drop point into the linger spot
        const end = lingerPos(npc, npc.to!, time, tmp);
        const s = 1 - (1 - u) * (1 - u);
        npc.pos.copy(npc.p0).lerp(end, s);
        break;
      }
    }
    if (dt > 0) npc.vel.subVectors(npc.pos, prev).divideScalar(dt);
    npc.trailL = easeTrail(npc.trailL, npc.phase === 'ftl' ? npc.vel.length() : 0, dt);
    if (npc.vel.lengthSq() > 1) npc.trailDir.copy(npc.vel).normalize().negate();
  }
}

/** A trail length eased toward TRAIL_S of travel at `speed` (m/s), capped at TRAIL_MAX. */
export function easeTrail(L: number, speed: number, dt: number) {
  const want = Math.min(TRAIL_MAX, speed * TRAIL_S);
  return L + (want - L) * Math.min(1, TRAIL_EASE * dt);
}

function nextPhase(npc: Npc, dests: Dest[], time: number) {
  const g = mulberry32(Math.floor(npc.seed * 1e3 + time));
  npc.t = 0;
  npc.p0.copy(npc.pos);
  switch (npc.phase) {
    case 'linger': {
      // somewhere else: not where it is
      const others = dests.filter((d) => d !== npc.at);
      npc.to = others[Math.floor(g() * others.length)];
      npc.phase = 'depart';
      npc.dur = MANEUVER_S;
      break;
    }
    case 'depart': {
      npc.phase = 'ftl';
      npc.dur = ftlTime(npc.pos.distanceTo(npc.to!.pos));
      npc.flashAt = time;
      break;
    }
    case 'ftl':
      npc.flashAt = time;
      npc.phase = 'arrive';
      npc.dur = MANEUVER_S;
      lingerAt(npc, npc.to!, g);
      break;
    case 'arrive':
      npc.at = npc.to!;
      npc.to = null;
      npc.phase = 'linger';
      npc.dur = rr(g, 40, 150);
      break;
  }
}
