/*
 * Traffic (docs/traffic.md): other ships going about their business in the system. They don't use
 * the physics the player does; each follows a scripted, kinematic cycle between destinations
 * (stations and worlds):
 *
 *   linger — hang off a station or circle a world in a low orbit for a while
 *   depart — pull away toward the next destination, speeding up (normal space)
 *   ftl    — cross to it in FTL: speed eases up and back down over the leg, the ship leaving a long
 *            fading trail of where it's been (TRAIL_S seconds of it)
 *   arrive — slow from the drop point into the linger spot at the destination
 *
 * Everything is worked out from the sim clock and the bodies' current positions, so time warp just
 * runs it faster. Ships don't collide, dock or interact yet.
 */
import type { Game } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { CurrentSystem, Target } from '../types';
import { dropAlt } from './ftl';
import { minOrbitAlt } from './orbits';

export type TrafficPhase = 'linger' | 'depart' | 'ftl' | 'arrive';

/** Seconds of FTL trail a ship leaves, and how often a point is laid down. */
export const TRAIL_S = 90,
  TRAIL_STEP = 0.5;
const TRAIL_N = Math.ceil(TRAIL_S / TRAIL_STEP) + 1;
/** Seconds departing and arriving, and the acceleration then (m/s²). */
const MANEUVER_S = 12,
  MANEUVER_ACC = 150;

export interface Npc {
  name: string;
  kind: string; // "Freighter", "Courier", …
  seed: number;
  at: Target; // where it is or last was
  to: Target | null; // where it's going (depart, ftl, arrive)
  phase: TrafficPhase;
  t: number; // seconds into the phase
  dur: number; // the phase's length (s)
  /** Linger offset from the body (m, world axes) and the circling rate (rad/s), for linger. */
  off: THREE.Vector3;
  spin: number;
  /** Start of the current leg (world, m): where depart / ftl / arrive began. */
  p0: THREE.Vector3;
  pos: THREE.Vector3; // world, m
  vel: THREE.Vector3; // m/s, system frame
  /** The trail: world positions and the sim times they were laid down (a ring). */
  trail: Float64Array;
  trailT: Float64Array;
  trailHead: number;
  trailLen: number;
  lastTrail: number;
}

const KINDS = ['Freighter', 'Courier', 'Tanker', 'Survey ship', 'Hauler', 'Liner'];
const NAMES = ['Kestrel', 'Meridian', 'Halcyon', 'Ostrava', 'Tamsin', 'Blue Heron', 'Corvid', 'Anselm', 'Petrel', 'Lodestar', 'Varuna', 'Ilse', 'Marrow', 'Sable', 'Quillon', 'Juniper'];

/** Places ships go: stations and worlds with a surface to orbit (not stars). */
const destinations = (cur: CurrentSystem): Target[] => [...cur.stations, ...cur.bodies.filter((b) => b.kind !== 'star')];

/** The ships in a system: a few, more with more stations. Deterministic per system. */
export function spawnTraffic(cur: CurrentSystem, simTime: number): Npc[] {
  const dests = destinations(cur);
  if (dests.length < 2) return [];
  const g = mulberry32(cur.sys.seed * 7 + 11);
  const n = Math.min(12, 3 + cur.stations.length * 2);
  const out: Npc[] = [];
  const names = [...NAMES];
  for (let i = 0; i < n; i++) {
    const at = dests[Math.floor(g() * dests.length)];
    const npc: Npc = {
      name: names.splice(Math.floor(g() * names.length), 1)[0], // each name once per system
      kind: KINDS[Math.floor(g() * KINDS.length)],
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
      trail: new Float64Array(TRAIL_N * 3),
      trailT: new Float64Array(TRAIL_N),
      trailHead: 0,
      trailLen: 0,
      lastTrail: simTime,
    };
    lingerAt(npc, at, g);
    out.push(npc);
  }
  return out;
}

/** A linger spot at `b`: a few km off a station, or a low circular orbit round a world. */
function lingerAt(npc: Npc, b: Target, g: () => number) {
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
function dropPoint(b: Target, from: THREE.Vector3, out: THREE.Vector3) {
  const r = b.kind === 'station' ? 60e3 : b.radius + dropAlt(b) * 1.3;
  return out.subVectors(from, b.pos).normalize().multiplyScalar(r).add(b.pos);
}

const tmp = new THREE.Vector3(),
  tmp2 = new THREE.Vector3(),
  prev = new THREE.Vector3(),
  AXIS = new THREE.Vector3(0, 1, 0);

/** The linger spot's current world position (it circles a world at orbital rate). */
function lingerPos(npc: Npc, b: Target, time: number, out: THREE.Vector3) {
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
    // the trail: laid down in FTL, and it keeps fading after the ship drops out
    if (npc.phase === 'ftl' && time - npc.lastTrail >= TRAIL_STEP) addTrail(npc, time);
  }
}

function addTrail(npc: Npc, time: number) {
  npc.lastTrail = time;
  const i = npc.trailHead;
  npc.trail[i * 3] = npc.pos.x;
  npc.trail[i * 3 + 1] = npc.pos.y;
  npc.trail[i * 3 + 2] = npc.pos.z;
  npc.trailT[i] = time;
  npc.trailHead = (i + 1) % TRAIL_N;
  npc.trailLen = Math.min(TRAIL_N, npc.trailLen + 1);
}

function nextPhase(npc: Npc, dests: Target[], time: number) {
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
      npc.trailLen = 0; // a fresh trail for this leg (the last one has faded by now)
      addTrail(npc, time);
      break;
    }
    case 'ftl':
      addTrail(npc, time);
      npc.phase = 'arrive';
      npc.dur = MANEUVER_S;
      lingerAt(npc, npc.to!, g);
      break;
    case 'arrive':
      npc.at = npc.to!;
      npc.to = null;
      npc.phase = 'linger';
      npc.dur = rr(g, 70, 180); // long enough for the last leg's trail to fade first
      break;
  }
}

/** The trail as camera-relative points (oldest first) with each point's age (s), for drawing. */
export function trailPoints(npc: Npc, origin: THREE.Vector3, time: number, out: { pos: Float32Array; age: Float32Array }) {
  let n = 0;
  for (let k = npc.trailLen; k > 0; k--) {
    const i = (npc.trailHead - k + TRAIL_N) % TRAIL_N;
    const age = time - npc.trailT[i];
    if (age > TRAIL_S) continue;
    out.pos[n * 3] = npc.trail[i * 3] - origin.x;
    out.pos[n * 3 + 1] = npc.trail[i * 3 + 1] - origin.y;
    out.pos[n * 3 + 2] = npc.trail[i * 3 + 2] - origin.z;
    out.age[n] = age;
    n++;
  }
  // and the ship itself, so the trail runs right up to it while in FTL
  if (npc.phase === 'ftl' && n > 0) {
    tmp2.subVectors(npc.pos, origin);
    out.pos[n * 3] = tmp2.x;
    out.pos[n * 3 + 1] = tmp2.y;
    out.pos[n * 3 + 2] = tmp2.z;
    out.age[n] = 0;
    n++;
  }
  return n;
}

export const TRAIL_MAX_POINTS = TRAIL_N + 1;
