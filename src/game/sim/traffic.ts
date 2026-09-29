/*
 * Traffic (docs/traffic.md): other ships going about their business in the system. Each one is a
 * ship like yours, flown by the same code you fly with: gravity and patched conics, the FTL drive
 * and its speed limits near worlds, the orbit autopilot (FTL transfer, insertion, orbit holds,
 * station rendezvous) and the docking computer (asks for a pad, flies the slot, lands, launches).
 * Only the pilot is different: a "captain" that hands everything to those computers.
 *
 * How: every ship has its own pilot context, `Object.create(game)`, with its own Ship and its own
 * copy of every piece of flight state (frame body, station frame, dock, docking computer, power bus,
 * messages …; see pilotFor). Reads of anything else (the system, the sim clock) fall through to the
 * game, so the flight code runs on it unchanged, and writes stay in the context.
 *
 * The captain's round:
 *
 *   docked — on a pad at a station for a while (tanks filled), then launches
 *   launch — the docking computer flies it up off the pad and out through the slot
 *   travel — picks somewhere else: a station (autopilot rendezvous, then the docking computer) or a
 *            world (the autopilot flies it into a circular orbit); the autopilot takes an FTL leg
 *            when it's worth it, like yours
 *   dock   — the docking computer: request, wait for the pad, the slot, the pad
 *   orbit  — in orbit round a world for a while, then travel again
 *
 * A leg that takes far too long is given up (another destination); a ship that crashes is replaced
 * by a new one docked at a station.
 *
 * Time warp: a ship sitting on a pad or coasting in orbit takes the warped step at once (on rails,
 * as yours does); a ship that's manoeuvring is stepped at most MAX_SUB × MAX_STEP of sim time per
 * frame, so under high warp it falls behind the clock (it still moves with its frame body).
 */
import type { Game } from '../Game';
import { newShip } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Npc, Station } from '../types';
import { AU, SHIP } from '../constants';
import { autopilot, ftlTransfer } from './autopilot';
import { autodock, engageAutodock } from './autodock';
import { holdDocked, launch, rotationCorrection, stationContact, updateDockRequest } from './docking';
import { resetFrame, syncFrame, updateFrame } from './frame';
import { collide, manualFlight } from './flight';
import { chargeFTL, dropFTL } from './ftl';
import { gravityAt } from './gravity';
import { defaultOrbitAlt, maxOrbitR, orbitNormal } from './orbits';
import { battCap, beginPower } from './power';
import { engageAutopilot, engageRendezvous, maybeFtlLeg } from './planner';
import { padCount } from './stationGeom';
import { ascent, catapultLaunch } from './catapult';
import { railsStep } from './timewarp';

export type { Npc };
/** Where ships go. */
type Dest = Body | Station;

/**
 * FTL trail: as long as TRAIL_S seconds of travel at the ship's current speed, up to TRAIL_MAX (m).
 * It grows and shrinks with the speed, easing at TRAIL_EASE (1/s), so it pulls in after drop-out.
 */
export const TRAIL_S = 30,
  TRAIL_MAX = 0.2 * AU,
  TRAIL_EASE = 1.5;
/** How long an FTL flash lasts (s). */
export const FLASH_S = 0.8;
/** A ship's size for the radar, scanner and clicks (m): half its ~60 m length. */
const SHIP_R = 30;
/** Flight steps: at most this long (s), and at most this many per frame (see time warp above). */
const MAX_STEP = 0.1,
  MAX_SUB = 10;
/** Power the ship's bus has (kW): plenty, so a captain never has to manage it. */
const NPC_POWER = 20e3;
/** How long it stays docked, or in orbit, before moving on (s). */
const DOCKED_S = [40, 240],
  ORBIT_S = [60, 300];
/** A leg taking longer than this (sim s) is given up. */
const GIVE_UP = 1800;

const KINDS = ['Freighter', 'Courier', 'Tanker', 'Survey ship', 'Hauler', 'Liner'];
const NAMES = ['Kestrel', 'Meridian', 'Halcyon', 'Ostrava', 'Tamsin', 'Blue Heron', 'Corvid', 'Anselm', 'Petrel', 'Lodestar', 'Varuna', 'Ilse', 'Marrow', 'Sable', 'Quillon', 'Juniper'];

/** Each ship's pilot context: a Game whose flight state is its own (see the top). */
const pilots = new WeakMap<Npc, Game>();
/** Its offset from its frame body before the bodies move (rideTraffic). */
const rides = new WeakMap<Npc, THREE.Vector3>();

/** The orbit a ship takes round a world: a little above the autopilot's default. */
const orbitAlt = (b: Body) => defaultOrbitAlt(b) * 1.1;
/** Worlds a ship can orbit: not stars, and with room for an orbit (not deep in a parent's pull). */
const orbitable = (cur: CurrentSystem) => cur.bodies.filter((b) => b.kind !== 'star' && maxOrbitR(b) > b.radius + orbitAlt(b));

/**
 * A pilot context for `game`: every piece of state the flight code writes is set here as the
 * context's own, so nothing reaches the game (or the player's ship) through the prototype.
 */
function pilotFor(game: Game): Game {
  const c = Object.create(game) as Game;
  const own: Record<string, unknown> = {
    ship: newShip(),
    power: { ...game.power, shadow: null, limited: null },
    aero: { ...game.aero },
    warned: {},
    msg: { text: '', kind: '', on: false, t: 0 },
    frameBody: game.cur.star,
    refFrame: null,
    _target: null,
    _jumpDest: null,
    jump: null,
    planner: null,
    guide: null,
    heat: null,
    route: null,
    scanning: null,
    dock: null,
    dockRequest: null,
    inStation: null,
    inStationRel: new THREE.Vector3(),
    autodock: null,
    autodockStation: null,
    autodockPad: 0,
    ascent: null,
    erosion: 0,
    rockThreat: null,
    nudging: false,
    dockRel: new THREE.Vector3(),
    qInv: new THREE.Quaternion(),
    fwd: new THREE.Vector3(),
    warp: 1,
    curSpeed: 0,
    apPanel: false,
    apConfirm: 0,
    orbitPreview: false,
    pivot: false,
    hudT: 0,
  };
  for (const k in own) Object.defineProperty(c, k, { value: own[k], writable: true, enumerable: true });
  Object.defineProperty(c, 'keys', { value: Object.create(null) }); // nobody at the controls
  return c;
}

/** The ships in a system: a few, more with more stations. Who and where is deterministic per system. */
export function spawnTraffic(game: Game): Npc[] {
  const cur = game.cur;
  const worlds = orbitable(cur);
  if (cur.stations.length + worlds.length < 2) return [];
  const g = mulberry32(cur.sys.seed * 7 + 11);
  const n = Math.min(12, 3 + cur.stations.length * 2);
  const out: Npc[] = [];
  const names = [...NAMES];
  for (let i = 0; i < n; i++) {
    const c = pilotFor(game);
    const npc: Npc = {
      kind: 'ship',
      radius: SHIP_R,
      name: names.splice(Math.floor(g() * names.length), 1)[0], // each name once per system
      cls: KINDS[Math.floor(g() * KINDS.length)],
      pos: c.ship.pos,
      vel: new THREE.Vector3(),
      q: c.ship.q,
      ftl: false,
      thrust: 0,
      task: 'docked',
      at: null,
      to: null,
      t: 0,
      wait: 0,
      trailL: 0,
      trailDir: new THREE.Vector3(0, 0, 1),
      flashAt: -Infinity,
    };
    pilots.set(npc, c);
    rides.set(npc, new THREE.Vector3());
    // most start on a pad, the rest in orbit; the first to leave go within a minute or so
    if (cur.stations.length && (g() < 0.65 || !worlds.length)) dockAt(npc, c, cur.stations[Math.floor(g() * cur.stations.length)], g);
    else placeInOrbit(npc, c, worlds[Math.floor(g() * worlds.length)], g);
    npc.t = npc.wait * g() * 0.9;
    syncView(npc, c, 0);
    out.push(npc);
  }
  return out;
}

/** Put it on a pad at `st`, tanks full. */
function dockAt(npc: Npc, c: Game, st: Station, g: () => number) {
  c.ship.ap = null;
  c.ship.mode = 'normal';
  c.autodock = null;
  c.dockRequest = null;
  c.dock = { station: st, pad: Math.floor(g() * padCount(st)), docked: true };
  resetFrame(c, gravityAt(c.cur, st.pos).body);
  holdDocked(c);
  refuel(c);
  npc.task = 'docked';
  npc.at = st;
  npc.to = null;
  npc.t = 0;
  npc.wait = rr(g, DOCKED_S[0], DOCKED_S[1]);
}

/** Put it straight into a circular orbit round `b` (at spawn), with the autopilot holding it. */
function placeInOrbit(npc: Npc, c: Game, b: Body, g: () => number) {
  const { ship } = c;
  const r = b.radius + orbitAlt(b);
  const n = orbitNormal(b, 'equatorial', 1, new THREE.Vector3(1, 0, 0));
  const u = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), g() * 6.28);
  u.addScaledVector(n, -u.dot(n)).normalize();
  ship.mode = 'normal';
  ship.pos.copy(b.pos).addScaledVector(u, r);
  resetFrame(c, gravityAt(c.cur, ship.pos).body);
  const tang = new THREE.Vector3().crossVectors(n, u);
  ship.vel.copy(tang).multiplyScalar(Math.sqrt(b.mu / r)).add(b.vel).sub(c.frameBody.vel);
  ship.q.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), tang, u)); // nose (−z) along the orbit
  orbit(c, b);
  npc.task = 'orbit';
  npc.at = b;
  npc.to = null;
  npc.t = 0;
  npc.wait = rr(g, ORBIT_S[0], ORBIT_S[1]);
}

/** Tanks and battery full: what a station does for it (and all it needs to keep going). */
function refuel(c: Game) {
  c.ship.prop = SHIP.propCap;
  c.ship.exotic = SHIP.exoticCap;
  c.ship.batt = battCap(c.ship);
  c.ship.hull = 1;
}

/** Engage the autopilot for a circular equatorial orbit round `b` (it takes an FTL leg if it's far). */
function orbit(c: Game, b: Body) {
  const r0 = b.radius + orbitAlt(b);
  const u = c.ship.pos.clone().sub(b.pos).normalize();
  engageAutopilot(c, { body: b, type: 'equatorial', r0, period: 2 * Math.PI * Math.sqrt(r0 ** 3 / b.mu), n: orbitNormal(b, 'equatorial', 1, u), point: null, station: null }, true);
}

/** Pick somewhere else to go and hand it to the autopilot. */
function setOff(npc: Npc, c: Game) {
  const stations = c.cur.stations.filter((s) => s !== npc.at);
  const worlds = orbitable(c.cur).filter((b) => b !== npc.at);
  const toStation = stations.length > 0 && (Math.random() < 0.6 || !worlds.length);
  const dest: Dest = toStation ? stations[Math.floor(Math.random() * stations.length)] : worlds[Math.floor(Math.random() * worlds.length)];
  npc.task = 'travel';
  npc.to = dest;
  npc.t = 0;
  c.target = dest; // a targeted station is its flight-assist frame from further out, as for you
  if (dest.kind === 'station') engageRendezvous(c, dest);
  else orbit(c, dest);
}

/** Before the bodies move: remember where each ship is relative to its frame body. */
export function rideTraffic(g: Game) {
  for (const npc of g.traffic) {
    const c = pilots.get(npc)!;
    rides.get(npc)!.subVectors(c.ship.pos, c.frameBody.pos);
  }
}

const tmpV0 = new THREE.Vector3(),
  tmpV1 = new THREE.Vector3(),
  tmpN = new THREE.Vector3();

/** After the bodies moved (dt: this step, s): carry each ship with its frame body, then fly it. */
export function updateTraffic(g: Game, dt: number) {
  for (const npc of g.traffic) {
    const c = pilots.get(npc)!;
    const { ship } = c;
    ship.pos.addVectors(c.frameBody.pos, rides.get(npc)!);
    const wasFtl = ship.mode === 'ftl';
    sysVel(c, tmpV0);
    npc.t += dt;
    captain(npc, c);
    const calm = !!c.dock?.docked || (ship.mode === 'normal' && !c.autodock && ship.ftlCharge <= 0 && !!ship.ap?.settled && ship.ap.type !== 'rendezvous');
    let flown = 0; // sim time flown step by step (gravity's share of the velocity change)
    if (calm && dt > MAX_STEP) {
      // warped, and nothing to fly: on rails like yours
      ship.grav = gravityAt(c.cur, ship.pos);
      if (c.dock?.docked) holdDocked(c);
      else {
        c.warp = g.warp;
        railsStep(c, dt);
      }
    } else {
      const n = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt / MAX_STEP)));
      const h = Math.min(MAX_STEP, dt / n);
      for (let i = 0; i < n && !ship.dead; i++) fly(c, h);
      flown = h * n;
    }
    if (ship.dead) {
      // lost (it hit something): a replacement turns up docked at a station
      ship.dead = null;
      const st = c.cur.stations[Math.floor(Math.random() * c.cur.stations.length)];
      if (st) dockAt(npc, c, st, Math.random);
      else placeInOrbit(npc, c, orbitable(c.cur)[0], Math.random);
    }
    // thrust: the velocity change gravity doesn't explain, along the nose (main engine) or against it
    npc.thrust = 0;
    if (flown > 0 && ship.mode === 'normal' && !c.dock?.docked) {
      const dv = sysVel(c, tmpV1).sub(tmpV0);
      if (ship.grav) dv.addScaledVector(ship.grav.vec, -flown);
      if (dv.length() > 2 * flown) npc.thrust = dv.dot(tmpN.set(0, 0, -1).applyQuaternion(ship.q)) >= 0 ? 1 : -1;
    }
    if (wasFtl !== (ship.mode === 'ftl')) npc.flashAt = g.simTime;
    syncView(npc, c, dt);
  }
}

/** The ship's velocity in the system frame. */
function sysVel(c: Game, out: THREE.Vector3) {
  return out.copy(c.ship.vel).add(c.frameBody.vel);
}

/** What the renderer, radar and info panel read. */
function syncView(npc: Npc, c: Game, dt: number) {
  const { ship } = c;
  npc.ftl = ship.mode === 'ftl';
  if (npc.ftl) npc.vel.copy(ship.travelDir).multiplyScalar(ship.ftlSpeed);
  else sysVel(c, npc.vel);
  npc.trailL = easeTrail(npc.trailL, npc.ftl ? ship.ftlSpeed : 0, dt);
  if (npc.ftl) npc.trailDir.copy(ship.travelDir).negate();
}

/** The captain: decides what to do next; the computers do the flying. */
function captain(npc: Npc, c: Game) {
  const { ship } = c;
  switch (npc.task) {
    case 'docked':
      if (!c.dock?.docked) npc.task = 'launch';
      else if (npc.t > npc.wait) {
        // the docking computer flies it out (WD-300); from a sky station, the catapult and ascent program
        if (c.dock.station.sky) catapultLaunch(c);
        else launch(c);
        npc.task = 'launch';
        npc.t = 0;
      }
      break;
    case 'launch':
      if (!c.autodock && !c.inStation && !c.ascent) setOff(npc, c);
      break;
    case 'travel': {
      const to = npc.to!;
      if (npc.t > GIVE_UP || (!ship.ap && ship.mode === 'normal' && ship.ftlCharge <= 0)) {
        // lost the autopilot (e.g. the drive failed) or getting nowhere: go somewhere else
        if (ship.mode === 'ftl') dropFTL(c, false);
        setOff(npc, c);
      } else if (ship.ap?.settled && to.kind === 'station') {
        // matched with the station: the docking computer asks for a pad and takes it in
        engageAutodock(c, to);
        npc.task = 'dock';
        npc.t = 0;
      } else if (ship.ap?.settled) {
        npc.task = 'orbit';
        npc.at = to;
        npc.to = null;
        npc.t = 0;
        npc.wait = rr(Math.random, ORBIT_S[0], ORBIT_S[1]);
        c.target = null;
      }
      break;
    }
    case 'dock':
      if (c.dock?.docked) {
        refuel(c);
        npc.task = 'docked';
        npc.at = c.dock.station;
        npc.to = null;
        npc.t = 0;
        npc.wait = rr(Math.random, DOCKED_S[0], DOCKED_S[1]);
        c.target = null;
      } else if (!c.autodock || npc.t > GIVE_UP / 3) {
        // turned away or stuck: try elsewhere
        c.autodock = null;
        c.dock = null;
        c.dockRequest = null;
        setOff(npc, c);
      }
      break;
    case 'orbit':
      if (!ship.ap) orbit(c, npc.at as Body);
      else if (npc.t > npc.wait) setOff(npc, c);
      break;
  }
}

/** One flight step: the player's (sim/update.ts), with the captain's computers at the controls. */
function fly(c: Game, dt: number) {
  const { ship, power } = c;
  power.solar = NPC_POWER;
  power.shore = 0;
  ship.batt = battCap(ship);
  beginPower(c);
  const apSteering = !!ship.ap && ship.ap.phase === 'transfer';
  c.qInv.copy(ship.q).invert();
  c.fwd.set(0, 0, -1).applyQuaternion(ship.q);
  if (apSteering) ship.travelDir.copy(c.fwd);
  chargeFTL(c, dt);
  updateFrame(c);
  if (c.dock?.docked) {
    ship.grav = gravityAt(c.cur, ship.pos);
    syncFrame(c, ship.grav.body);
    holdDocked(c);
  } else if (ship.mode === 'normal') {
    const grav = (ship.grav = gravityAt(c.cur, ship.pos));
    syncFrame(c, grav.body);
    maybeFtlLeg(c);
    rotationCorrection(c, dt);
    if (c.autodock) autodock(c, dt, grav.vec);
    else if (c.ascent && ascent(c, dt, grav)) {
      /* off a sky station's catapult: the ascent program flies it out of the air */
    } else if (ship.ap && ship.ap.phase === 'insert') autopilot(c, dt, grav);
    else manualFlight(c, dt, grav, [0, 0, 0]); // flight assist, hands off
    ship.pos.addScaledVector(ship.vel, dt);
    collide(c, dt);
    stationContact(c);
  } else if (ship.ap?.phase === 'transfer') ftlTransfer(c, dt); // (the drive may have just engaged)
  else dropFTL(c, false); // in FTL with nothing flying it: shouldn't happen, but don't cruise forever
  if (ship.mode === 'ftl') {
    ship.grav = gravityAt(c.cur, ship.pos);
    syncFrame(c, ship.grav.body);
  }
  updateDockRequest(c, dt);
}

/** What it's doing, for the info panel. */
export function npcStatus(npc: Npc) {
  const c = pilots.get(npc);
  const ship = c?.ship;
  const at = npc.at?.name ?? '?',
    to = npc.to?.name ?? '?';
  switch (npc.task) {
    case 'docked':
      return `docked at ${at}`;
    case 'launch':
      return `launching from ${at}`;
    case 'dock': {
      const ph = c?.autodock?.phase;
      if (c?.dockRequest || ph === 'wait') return `waiting for clearance · ${to}`;
      return ph === 'enter' || ph === 'descend' ? `docking at ${to} · pad ${(c?.dock?.pad ?? 0) + 1}` : `approaching ${to}`;
    }
    case 'orbit':
      return `in orbit round ${at}`;
    case 'travel':
      if (ship?.mode === 'ftl') return `FTL transfer to ${to}`;
      if (ship?.ap?.phase === 'charge') return `charging FTL for ${to}`;
      return npc.to?.kind === 'station' ? `closing on ${to}` : `entering orbit round ${to}`;
  }
}

/** A trail length eased toward TRAIL_S of travel at `speed` (m/s), capped at TRAIL_MAX. */
export function easeTrail(L: number, speed: number, dt: number) {
  const want = Math.min(TRAIL_MAX, speed * TRAIL_S);
  return L + (want - L) * Math.min(1, TRAIL_EASE * dt);
}

/** A ship's pilot context (its Ship, dock, autopilot …): for saving (save.ts) and debugging. */
export const pilotOf = (npc: Npc) => pilots.get(npc);

/**
 * A ship with a fresh pilot context and nothing set yet, for restoring a save: save.ts fills in its
 * pilot's flight state and its captain's task, then calls syncNpc.
 */
export function blankNpc(game: Game, name: string, cls: string) {
  const pilot = pilotFor(game);
  const npc: Npc = {
    kind: 'ship', radius: SHIP_R, name, cls, pos: pilot.ship.pos, vel: new THREE.Vector3(), q: pilot.ship.q,
    ftl: false, thrust: 0, task: 'docked', at: null, to: null, t: 0, wait: 0, trailL: 0, trailDir: new THREE.Vector3(0, 0, 1), flashAt: -Infinity,
  };
  pilots.set(npc, pilot);
  rides.set(npc, new THREE.Vector3());
  return { npc, pilot };
}

/** Refresh what the renderer, radar and info panel read from the ship's pilot (after a restore). */
export function syncNpc(npc: Npc) {
  const c = pilots.get(npc)!;
  syncView(npc, c, 0);
  if (npc.ftl) npc.trailDir.copy(c.ship.travelDir).negate();
}
