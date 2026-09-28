/*
 * Traffic (docs/traffic.md): other ships going about their business in the system. They don't use
 * the physics the player does, but they move like piloted ships, between destinations (stations
 * and worlds):
 *
 *   linger — parked a few km off a station (holding its heading) or in a low orbit round a world
 *            (nose along the orbit), for a while
 *   turn   — swings its nose toward the next destination at TURN_RATE, still parked
 *   depart — main engine: thrust builds up over a couple of seconds and the ship speeds up along its
 *            nose, still carried along with the station or orbit it left, to DEPART_V
 *   ftl    — a flash, then the FTL leg: speed eases up and back down, a trail streaming behind
 *            (TRAIL_S seconds of travel at its current speed, up to TRAIL_MAX)
 *   arrive — a flash at drop-out, still moving fast toward the destination; it brakes along a smooth
 *            curve (Hermite, in the destination's own frame) into its parking spot there, nose along
 *            its motion until it's nearly stopped
 *
 * Everything follows the sim clock and the bodies' current positions, so time warp just runs it
 * faster. Ships don't collide, dock or answer yet.
 */
import type { Game } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Npc, Station } from '../types';
import { dropAlt } from './ftl';
import { minOrbitAlt } from './orbits';

export type { Npc };
/** Where ships go. */
type Dest = Body | Station;


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
/** Turning rate (rad/s), main-engine acceleration (m/s²) and the time it takes to build up (s), and
 * the speed a ship leaves at before it goes to FTL (m/s). */
const TURN_RATE = 0.15,
  DEPART_ACC = 30,
  THRUST_RAMP = 2.5,
  DEPART_V = 450;
/** Drop-out speed (m/s) needed to arrive over `dist` metres in `T` seconds without overshooting. */
const arriveTime = (dist: number) => Math.min(180, 30 + dist / 5000);

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
      q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(g() - 0.5, g() - 0.5, g() - 0.5).normalize(), g() * 6.28),
      thrust: 0,
      dir: new THREE.Vector3(),
      sv: 0,
      ss: 0,
      rel0: new THREE.Vector3(),
      relV0: new THREE.Vector3(),
      rel1: new THREE.Vector3(),
      relV1: new THREE.Vector3(),
    };
    lingerAt(npc, at, g);
    out.push(npc);
  }
  return out;
}

/**
 * A linger spot at `b`: a few km off a station, or a low circular orbit round a world. With `side`
 * (world, from b), on that side: an arriving ship parks on the side it comes in from, never the far one.
 */
function lingerAt(npc: Npc, b: Dest, g: () => number, side?: THREE.Vector3) {
  const dir = new THREE.Vector3(g() - 0.5, (g() - 0.5) * 0.4, g() - 0.5).normalize();
  if (side) dir.multiplyScalar(0.35).add(tmp2.copy(side).normalize()).normalize();
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
  tmp2 = new THREE.Vector3(),
  prev = new THREE.Vector3(),
  want = new THREE.Quaternion(),
  m4 = new THREE.Matrix4(),
  ZERO = new THREE.Vector3(),
  UP = new THREE.Vector3(0, 1, 0),
  AXIS = new THREE.Vector3(0, 1, 0);

/** The linger spot's current world position (it circles a world at orbital rate). */
function lingerPos(npc: Npc, b: Dest, time: number, out: THREE.Vector3) {
  return out.copy(npc.off).applyAxisAngle(AXIS, npc.spin * time).add(b.pos);
}

/** Its velocity against the body there (the orbit's, round a world). */
function lingerVel(npc: Npc, time: number, out: THREE.Vector3) {
  return out.copy(npc.off).applyAxisAngle(AXIS, npc.spin * time).applyAxisAngle(AXIS, Math.PI / 2).multiplyScalar(npc.spin).setY(0);
}

/** Turn the nose toward `fwd` (world, unit) at up to `rate` rad/s. Returns the angle left. */
function turnToward(npc: Npc, fwd: THREE.Vector3, rate: number, dt: number) {
  if (fwd.lengthSq() < 1e-12) return 0;
  m4.lookAt(fwd, ZERO, Math.abs(fwd.y) > 0.99 ? tmp2.set(1, 0, 0) : UP); // +z along fwd (Object3D.lookAt's convention)
  want.setFromRotationMatrix(m4);
  npc.q.rotateTowards(want, rate * dt);
  return npc.q.angleTo(want);
}

/** Advance every ship to the current sim time (dt: this step, s). */
export function updateTraffic(g: Game, dt: number) {
  const time = g.simTime;
  const dests = destinations(g.cur);
  for (const npc of g.traffic) {
    prev.copy(npc.pos);
    npc.t += dt;
    npc.thrust = 0;
    switch (npc.phase) {
      case 'linger': {
        lingerPos(npc, npc.at, time, npc.pos);
        // round a world: nose along the orbit; off a station: holds its heading
        if (npc.spin) turnToward(npc, lingerVel(npc, time, tmp).normalize(), TURN_RATE, dt);
        if (npc.t >= npc.dur) nextPhase(npc, dests, time);
        break;
      }
      case 'turn': {
        lingerPos(npc, npc.at, time, npc.pos);
        const left = turnToward(npc, tmp.subVectors(npc.to!.pos, npc.pos).normalize(), TURN_RATE, dt);
        if (left < 0.02 || npc.t > 40) nextPhase(npc, dests, time);
        break;
      }
      case 'depart': {
        // thrust builds up, then a steady push along the nose
        const a = DEPART_ACC * Math.min(1, npc.t / THRUST_RAMP);
        npc.sv += a * dt;
        npc.ss += npc.sv * dt;
        npc.thrust = 1;
        turnToward(npc, npc.dir, TURN_RATE, dt);
        lingerPos(npc, npc.at, time, npc.pos).addScaledVector(npc.dir, npc.ss);
        if (npc.sv >= DEPART_V) nextPhase(npc, dests, time);
        break;
      }
      case 'ftl': {
        const u = Math.min(1, npc.t / npc.dur);
        const end = dropPoint(npc.to!, npc.p0, tmp);
        const s = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: speed eases in and out
        npc.pos.copy(npc.p0).lerp(end, s);
        npc.thrust = 1;
        turnToward(npc, tmp2.subVectors(end, npc.p0).normalize(), TURN_RATE * 4, dt);
        if (npc.t >= npc.dur) nextPhase(npc, dests, time);
        break;
      }
      case 'arrive': {
        // a Hermite curve in the destination's frame: from the drop-out point at its speed to the
        // parking spot at rest, so it brakes smoothly without overshooting
        const T = npc.dur,
          u = Math.min(1, npc.t / T);
        const u2 = u * u,
          u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1,
          h10 = u3 - 2 * u2 + u,
          h01 = -2 * u3 + 3 * u2,
          h11 = u3 - u2;
        npc.pos.copy(npc.rel0).multiplyScalar(h00).addScaledVector(npc.relV0, h10 * T).addScaledVector(npc.rel1, h01).addScaledVector(npc.relV1, h11 * T).add(npc.to!.pos);
        // velocity against the destination: nose along it while it's still moving, braking
        const d00 = 6 * u2 - 6 * u,
          d10 = 3 * u2 - 4 * u + 1,
          d01 = -6 * u2 + 6 * u,
          d11 = 3 * u2 - 2 * u;
        const rv = tmp.copy(npc.rel0).multiplyScalar(d00 / T).addScaledVector(npc.relV0, d10).addScaledVector(npc.rel1, d01 / T).addScaledVector(npc.relV1, d11);
        if (rv.lengthSq() > 25) turnToward(npc, rv.normalize(), TURN_RATE, dt);
        npc.thrust = u < 0.85 ? -1 : 0;
        if (npc.t >= npc.dur) nextPhase(npc, dests, time);
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
      // somewhere else: not where it is; first turn toward it
      const others = dests.filter((d) => d !== npc.at);
      npc.to = others[Math.floor(g() * others.length)];
      npc.phase = 'turn';
      break;
    }
    case 'turn':
      npc.phase = 'depart';
      npc.dir.set(0, 0, 1).applyQuaternion(npc.q); // along the nose
      npc.sv = npc.ss = 0;
      break;
    case 'depart':
      npc.phase = 'ftl';
      npc.dur = ftlTime(npc.pos.distanceTo(npc.to!.pos));
      npc.flashAt = time;
      break;
    case 'ftl': {
      npc.flashAt = time;
      npc.phase = 'arrive';
      // relative to the destination: where it dropped out, how fast it's going in, where it'll park
      const b = npc.to!;
      npc.rel0.subVectors(npc.pos, b.pos);
      // park on the near side; round a world the spot circles (off is its t = 0 position), so set
      // it back by the orbit's turn until the ship gets there
      lingerAt(npc, b, g, npc.rel0);
      npc.dur = arriveTime(npc.rel0.distanceTo(npc.off));
      npc.off.applyAxisAngle(AXIS, -npc.spin * (time + npc.dur));
      // the spot where it'll be when it gets there (it circles a world), and its orbital velocity then
      npc.rel1.copy(npc.off).applyAxisAngle(AXIS, npc.spin * (time + npc.dur));
      lingerVel(npc, time + npc.dur, npc.relV1);
      // coming in toward the spot at 1.5× the average speed: it brakes all the way without overshooting
      npc.relV0.subVectors(npc.rel1, npc.rel0).multiplyScalar(1.5 / npc.dur);
      break;
    }
    case 'arrive':
      npc.at = npc.to!;
      npc.to = null;
      npc.phase = 'linger';
      npc.dur = rr(g, 40, 150);
      break;
  }
}
