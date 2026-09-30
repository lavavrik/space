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
 * Time warp: a ship sitting on a pad or coasting in orbit takes each step at once (on rails, as
 * yours does, warped or not); a ship that's manoeuvring is stepped at most MAX_SUB × MAX_STEP of sim time per
 * frame, so under high warp it falls behind the clock (it still moves with its frame body).
 */
import type { Game } from '../Game';
import { newShip } from '../Game';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Npc, Station } from '../types';
import { SHIP } from '../constants';
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
import { laserOff } from './laser';
import { mapClosed } from '../render/SystemMap';
import { railsStep } from './timewarp';
import { rootOf } from './control';

export type { Npc };
/** Where ships go. */
type Dest = Body | Station;

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
const DOCKED_S = [120, 1200],
  ORBIT_S = [60, 400];
/**
 * How many ships: a few, a crowd per station (its pads kept about half full), a couple per world,
 * at most MAX_TRAFFIC. Each costs ~10 µs of CPU per flight step, so the count isn't limited by the
 * flying; a station's slot is: one ship at a time, ~50 s a pass (in ~30, out ~20), about 35
 * arrivals and 35 departures an hour at most. Hence the long stays on a pad, and captains going
 * where there's room (setOff).
 */
const MAX_TRAFFIC = 200,
  PER_STATION = 14,
  PER_SKY_STATION = 8,
  PER_WORLD = 2,
  BASE_SHIPS = 4;
/** A station counts as full once this share of its pads is held or spoken for… */
const FULL = 0.85;
/** …or this many ships are already on their way in (in transit or queueing to dock). */
const INBOUND_MAX = 4;
/**
 * Flight steps for all the ships together per frame. Unwarped each ship takes one or two; under time
 * warp they share this (≈ 5 ms), each at most MAX_SUB steps, and a manoeuvring one falls behind the
 * clock when its share runs out (still carried with its frame body; one on rails doesn't need it).
 */
const STEP_BUDGET = 600;
/** A leg taking longer than this (sim s) is given up. */
const GIVE_UP = 1800;

const KINDS = ['Freighter', 'Courier', 'Tanker', 'Survey ship', 'Hauler', 'Liner'];
const NAMES = [
  'Kestrel', 'Meridian', 'Halcyon', 'Ostrava', 'Tamsin', 'Blue Heron', 'Corvid', 'Anselm', 'Petrel', 'Lodestar', 'Varuna', 'Ilse', 'Marrow', 'Sable', 'Quillon', 'Juniper',
  'Albatross', 'Brightwater', 'Cassia', 'Dunlin', 'Ember', 'Fennec', 'Gannet', 'Harrier', 'Iona', 'Jacana', 'Kittiwake', 'Larkspur', 'Mistral', 'Nightjar', 'Osprey', 'Pelagia',
  'Quiver', 'Rook', 'Sirocco', 'Tern', 'Umber', 'Vesper', 'Wren', 'Xanthe', 'Yarrow', 'Zephyr', 'Arden', 'Bittern', 'Coriander', 'Dogger', 'Egret', 'Fastnet',
];
/** The `i`th of a system's names: each once, then again with a number (Kestrel II, III…). */
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII'];
function shipName(order: string[], i: number) {
  return order[i % order.length] + ROMAN[Math.floor(i / order.length) % ROMAN.length];
}

/** Each ship's pilot context: a Game whose flight state is its own (see the top). */
const pilots = new WeakMap<Npc, Game>();
/** Its offset from its frame body before the bodies move (rideTraffic). */
const rides = new WeakMap<Npc, THREE.Vector3>();
/** On a pad: its offset from the station, as last held there (updateTraffic). */
const dockOffs = new WeakMap<Npc, THREE.Vector3>();
/** A docked ship this far from you (m) isn't held on its pad each frame (updateTraffic). */
const PARKED_FAR = 100e3;

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
    laser: laserOff(),
    map: mapClosed(),
    dockRel: new THREE.Vector3(),
    qInv: new THREE.Quaternion(),
    fwd: new THREE.Vector3(),
    warp: 1,
    curSpeed: 0,
    apPanel: false,
    apConfirm: 0,
    orbitPreview: false,
    pivot: false,
    pivotRate: 0,
    pivotLocked: false,
    lockOmega: new THREE.Vector3(),
    pivotPrevDir: null,
    angVel: new THREE.Vector3(),
    mouseRate: new THREE.Vector3(),
    steerUp: null,
    steerQ: new THREE.Quaternion(),
    hudT: 0,
  };
  for (const k in own) Object.defineProperty(c, k, { value: own[k], writable: true, enumerable: true });
  Object.defineProperty(c, 'keys', { value: Object.create(null) }); // nobody at the controls
  return c;
}

/** How many ships a system has (see MAX_TRAFFIC). */
export function trafficCount(cur: CurrentSystem) {
  return Math.min(MAX_TRAFFIC, BASE_SHIPS + cur.stations.reduce((s, st) => s + (st.sky ? PER_SKY_STATION : PER_STATION), 0) + orbitable(cur).length * PER_WORLD);
}

/**
 * The ships in a system: a few, a crowd per station. Who and where is deterministic per system.
 * `have`: ships already here (a save from before there were this many): only the rest are made,
 * clear of their pads.
 */
export function spawnTraffic(game: Game, have: Npc[] = []): Npc[] {
  const cur = game.cur;
  const worlds = orbitable(cur);
  if (cur.stations.length + worlds.length < 2) return [];
  const g = mulberry32(cur.sys.seed * 7 + 11);
  const n = trafficCount(cur);
  const out: Npc[] = [];
  // the names in this system's order
  const order = [...NAMES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(g() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const taken = new Set(have.map((h) => h.name));
  for (let k = 0; out.length < n - have.length; ) {
    const name = shipName(order, k++);
    if (taken.has(name)) continue;
    const c = pilotFor(game);
    const npc: Npc = {
      kind: 'ship',
      radius: SHIP_R,
      name,
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
      flashAt: -Infinity,
    };
    pilots.set(npc, c);
    rides.set(npc, new THREE.Vector3());
    // most start on a pad (a free one: a crowded station sends the rest into orbit), the rest in
    // orbit; departures are staggered over their stays
    const st = cur.stations.length && (g() < 0.65 || !worlds.length) ? cur.stations[Math.floor(g() * cur.stations.length)] : null;
    const pad = st ? freePad([...have, ...out], st, g) : -1;
    if (st && pad >= 0) dockAt(npc, c, st, g, pad);
    else placeInOrbit(npc, c, st && worlds.includes(st.parent) ? st.parent : worlds[Math.floor(g() * worlds.length)], g);
    npc.t = npc.wait * g() * 0.9;
    syncView(npc, c);
    out.push(npc);
  }
  return out;
}

/** A pad at `st` none of `ships` is on (-1: all taken), at random. */
function freePad(ships: Npc[], st: Station, g: () => number) {
  const held = new Set<number>();
  for (const n of ships) {
    const d = pilots.get(n)?.dock;
    if (d?.station === st) held.add(d.pad);
  }
  const free = [...Array(padCount(st)).keys()].filter((i) => !held.has(i));
  return free.length ? free[Math.floor(g() * free.length)] : -1;
}

/** Put it on a pad at `st` (a given one, or any), tanks full. */
function dockAt(npc: Npc, c: Game, st: Station, g: () => number, pad = Math.floor(g() * padCount(st))) {
  c.ship.ap = null;
  c.ship.mode = 'normal';
  c.autodock = null;
  c.dockRequest = null;
  c.dock = { station: st, pad, docked: true };
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
  c.ship.cargo = {};
}

/** Engage the autopilot for a circular equatorial orbit round `b` (it takes an FTL leg if it's far). */
function orbit(c: Game, b: Body) {
  const r0 = b.radius + orbitAlt(b);
  const u = c.ship.pos.clone().sub(b.pos).normalize();
  engageAutopilot(c, { body: b, type: 'equatorial', r0, period: 2 * Math.PI * Math.sqrt(r0 ** 3 / b.mu), n: orbitNormal(b, 'equatorial', 1, u), point: null, station: null }, true);
}

/**
 * How busy `st` is for a captain deciding whether to go there: the share of its pads held or
 * spoken for (docked, or granted to a ship on its way in), and how many ships are headed in.
 */
function load(root: Game, st: Station, self: Npc) {
  let held = 0,
    inbound = 0;
  for (const n of root.traffic) {
    if (n === self) continue;
    const c = pilots.get(n);
    if (c?.dock?.station === st) held++;
    if (n.to === st && (n.task === 'travel' || n.task === 'dock')) inbound++;
  }
  return { share: held / padCount(st), inbound };
}

/**
 * Pick somewhere else to go and hand it to the autopilot: a station with room (not nearly full,
 * not too many already on their way in), or a world to orbit for a while.
 */
function setOff(npc: Npc, c: Game) {
  const root = rootOf(c);
  const stations = c.cur.stations.filter((s) => {
    if (s === npc.at) return false;
    const l = load(root, s, npc);
    return l.share < FULL && l.inbound < INBOUND_MAX;
  });
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

const ORIGIN = new THREE.Vector3(),
  tmpM = new THREE.Matrix4();
const tmpV0 = new THREE.Vector3(),
  tmpV1 = new THREE.Vector3(),
  tmpN = new THREE.Vector3();

/** After the bodies moved (dt: this step, s): carry each ship with its frame body, then fly it. */
export function updateTraffic(g: Game, dt: number) {
  // this frame's share of the step budget for each ship that has to be flown step by step
  const want = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt / MAX_STEP)));
  const perShip = want * g.traffic.length <= STEP_BUDGET ? want : Math.max(1, Math.floor(STEP_BUDGET / g.traffic.length));
  for (const npc of g.traffic) {
    const c = pilots.get(npc)!;
    const { ship } = c;
    ship.pos.addVectors(c.frameBody.pos, rides.get(npc)!);
    // on a pad at a station you're nowhere near, and not leaving yet: it just stays at its pad's
    // offset from the station (not turned with the hangar's spin; that's put right when it's seen
    // or leaves). A full hold on the pad each frame cost more than all the flying ships together.
    const d = c.dock;
    if (d?.docked && npc.t + dt <= npc.wait && !npc.ftl && g.inStation !== d.station && d.station.pos.distanceToSquared(g.ship.pos) > PARKED_FAR ** 2) {
      const off = dockOffs.get(npc);
      if (off) {
        ship.pos.addVectors(d.station.pos, off);
        npc.t += dt;
        syncView(npc, c);
        continue;
      }
    }
    const wasFtl = ship.mode === 'ftl';
    sysVel(c, tmpV0);
    npc.t += dt;
    captain(npc, c);
    // (in orbit round a world, the autopilot's hold needn't fly it: its orbit is circular already)
    const calm = !!c.dock?.docked || (ship.mode === 'normal' && !c.autodock && ship.ftlCharge <= 0 && !!ship.ap && ship.ap.type !== 'rendezvous' && (ship.ap.settled || npc.task === 'orbit'));
    let flown = 0; // sim time flown step by step (gravity's share of the velocity change)
    if (calm) {
      // nothing to fly (on a pad, or coasting in a settled orbit): on rails like yours, at any speed
      // (step by step, a hundred parked ships cost ~1 ms a frame for nothing)
      ship.grav = gravityAt(c.cur, ship.pos);
      if (c.dock?.docked) holdDocked(c);
      else {
        c.warp = g.warp;
        railsStep(c, dt);
        // nose along the orbit, as the autopilot holds it (rails alone keep it fixed in space)
        tmpN.subVectors(ship.pos, c.frameBody.pos).normalize();
        if (ship.vel.lengthSq() > 1) ship.q.setFromRotationMatrix(tmpM.lookAt(ORIGIN, ship.vel, tmpN));
      }
    } else {
      const n = perShip;
      const h = Math.min(MAX_STEP, dt / n);
      for (let i = 0; i < n && !ship.dead; i++) fly(c, h);
      flown = h * n;
    }
    if (ship.dead) {
      // lost (it hit something): a replacement turns up docked at a station
      ship.dead = null;
      const st = c.cur.stations[Math.floor(Math.random() * c.cur.stations.length)];
      const pad = st ? freePad(g.traffic, st, Math.random) : -1;
      if (st && pad >= 0) dockAt(npc, c, st, Math.random, pad);
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
    if (c.dock?.docked) dockOffs.set(npc, (dockOffs.get(npc) ?? new THREE.Vector3()).subVectors(ship.pos, c.dock.station.pos));
    else dockOffs.delete(npc);
    syncView(npc, c);
  }
}

/** The ship's velocity in the system frame. */
function sysVel(c: Game, out: THREE.Vector3) {
  return out.copy(c.ship.vel).add(c.frameBody.vel);
}

/** What the renderer, radar and info panel read. */
function syncView(npc: Npc, c: Game) {
  const { ship } = c;
  npc.ftl = ship.mode === 'ftl';
  if (npc.ftl) npc.vel.copy(ship.travelDir).multiplyScalar(ship.ftlSpeed);
  else sysVel(c, npc.vel);
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
    ftl: false, thrust: 0, task: 'docked', at: null, to: null, t: 0, wait: 0, flashAt: -Infinity,
  };
  pilots.set(npc, pilot);
  rides.set(npc, new THREE.Vector3());
  return { npc, pilot };
}

/** Refresh what the renderer, radar and info panel read from the ship's pilot (after a restore). */
export function syncNpc(npc: Npc) {
  const c = pilots.get(npc)!;
  syncView(npc, c);
}
