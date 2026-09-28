/*
 * Saving and resuming (docs/saving.md). One save, in the browser's localStorage, written every
 * AUTOSAVE_S seconds and whenever the page is hidden or closed, and read when the game starts.
 *
 * The universe is generated from seeds, so a save only needs what changed: which system you're in
 * and the sim clock (every world's orbit and spin, and every station's, follow from it), your ship
 * and every other ship in the system (FlightSave: where each is relative to its frame body, its
 * motion, tanks, heat, fitted modules and computers, and what it's doing: docked, a docking request,
 * the docking computer, the autopilot), what the other ships' captains are up to, a hyperjump, what
 * you've found and scanned, the target, and a few settings.
 *
 * Objects are saved by name or id: bodies and stations by name within the system, systems by id,
 * modules and computers by catalog id. Not saved: a nav route in flight (its waypoints are kept;
 * engage it again), a tanker on its way, the orbit planner, a scan in progress. A hyperjump under
 * way is saved as its destination: you arrive there (and meet that system's ships afresh). A lost
 * ship isn't saved (the last save stands).
 */
import type { Game } from './Game';
import { THREE } from './lib/three';
import { ALL_COMPUTERS, type Avionics } from './avionics/catalog';
import { batteryById, moduleById } from './outfit/catalog';
import type { ApType, Npc, Target } from './types';
import { systemById } from './universe/galaxy';
import { resetFrame } from './sim/frame';
import { arriveAt } from './sim/navigation';
import { startDockGuide, startOrbitGuide } from './sim/guide';
import type { AutoPhase } from './sim/autodock';
import type { NavMode } from './sim/navroute';
import { blankNpc, pilotOf, syncNpc } from './sim/traffic';

/** localStorage key; bump the version when the format changes incompatibly (old saves are ignored). */
export const SAVE_KEY = 'farlight.save';
export const SAVE_VERSION = 1;
/** Seconds of real time between autosaves. */
export const AUTOSAVE_S = 15;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** A ship's own state. */
export interface ShipSave {
  rel: V3; // position relative to the frame body (m)
  vel: V3; // relative to the frame body (m/s)
  q: Q4;
  mode: 'normal' | 'ftl';
  throttle: number;
  cruise: boolean;
  ftlSpeed: number;
  fa: boolean;
  decoupled: boolean;
  travelDir: V3;
  prop: number;
  exotic: number;
  batt: number;
  temp: number;
  vent: boolean;
  sunTrack: boolean;
  landed: string | null;
  outfit: { battery: string; slots: (string | null)[]; radiatorsOut: number; deploy: boolean; pumpAuto: boolean };
  avionics: Record<keyof Avionics, string | null>;
  ap: {
    body: string;
    type: ApType;
    station: string | null;
    r0: number;
    period: number;
    n: V3 | null;
    point: V3 | null;
    phase: 'charge' | 'transfer' | 'insert';
    settled: boolean;
  } | null;
}

/** A ship and the flight state around it: yours (the game), or another ship's (its pilot context). */
export interface FlightSave {
  frame: string; // frame body's name
  ship: ShipSave;
  dock: { station: string; pad: number; docked: boolean } | null;
  dockRequest: { station: string; t: number } | null;
  autodock: { phase: AutoPhase; station: string; pad: number } | null;
  refFrame: string | null;
  target: { kind: 'body' | 'station'; name: string } | null;
}

/** Another ship: who it is, what its captain is doing (sim/traffic.ts), and its flight state. */
export interface NpcSave {
  name: string;
  cls: string;
  task: Npc['task'];
  at: string | null; // body or station name
  to: string | null;
  t: number;
  wait: number;
  trailL: number;
  flashAt: number | null; // null: never
  flight: FlightSave;
}

/** What's written (JSON). Your flight state sits at the top level. */
export interface SaveData extends FlightSave {
  v: number;
  savedAt: number; // wall clock, ms
  sys: string; // system id
  simTime: number;
  jumpTo: string | null; // a hyperjump under way: its destination (you arrive there on load)
  jumpDest: string | null;
  scans: [string, number][];
  seen: string[];
  navPoints: string[];
  navFinal: Game['navFinal'];
  navMode: NavMode;
  settings: { lights: boolean; orbitPreview: boolean; radarVisible: boolean };
  /** The other ships in the system (absent in older saves: they're spawned afresh). */
  traffic?: NpcSave[];
}

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const V = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** A ship's flight state, from the game (yours) or a pilot context (another ship's). */
function snapshotFlight(c: Game): FlightSave {
  const { ship } = c;
  const fb = c.frameBody;
  const ap = ship.ap;
  const t = c.target;
  return {
    frame: fb.name,
    ship: {
      rel: v3(ship.pos.clone().sub(fb.pos)),
      vel: v3(ship.vel),
      q: [ship.q.x, ship.q.y, ship.q.z, ship.q.w],
      mode: ship.mode,
      throttle: ship.throttle,
      cruise: ship.cruise,
      ftlSpeed: ship.ftlSpeed,
      fa: ship.fa,
      decoupled: ship.decoupled,
      travelDir: v3(ship.travelDir),
      prop: ship.prop,
      exotic: ship.exotic,
      batt: ship.batt,
      temp: ship.temp,
      vent: ship.vent,
      sunTrack: ship.sunTrack,
      landed: ship.landed?.name ?? null,
      outfit: {
        battery: ship.outfit.battery.id,
        slots: ship.outfit.slots.map((m) => m?.id ?? null),
        radiatorsOut: ship.outfit.radiatorsOut,
        deploy: ship.outfit.deploy,
        pumpAuto: ship.outfit.pumpAuto,
      },
      avionics: { orbit: ship.avionics.orbit?.id ?? null, scanner: ship.avionics.scanner?.id ?? null, nav: ship.avionics.nav?.id ?? null, dock: ship.avionics.dock?.id ?? null },
      ap: ap && {
        body: ap.body.name,
        type: ap.type,
        station: ap.station?.name ?? null,
        r0: ap.r0,
        period: ap.period,
        n: ap.n && v3(ap.n),
        point: ap.point && v3(ap.point),
        // mid-charge the drive's charge isn't saved: it goes back to insertion, which re-charges
        phase: ap.phase === 'charge' ? 'insert' : ap.phase,
        settled: ap.settled,
      },
    },
    dock: c.dock && { station: c.dock.station.name, pad: c.dock.pad, docked: c.dock.docked },
    dockRequest: c.dockRequest && { station: c.dockRequest.station.name, t: c.dockRequest.t },
    autodock: c.autodock && c.autodockStation ? { phase: c.autodock.phase, station: c.autodockStation.name, pad: c.autodockPad } : null,
    refFrame: c.refFrame?.name ?? null,
    target: t && t.kind !== 'ship' ? { kind: t.kind === 'station' ? 'station' : 'body', name: t.name } : null,
  };
}

function snapshotNpc(npc: Npc): NpcSave | null {
  const c = pilotOf(npc);
  if (!c || c.ship.dead) return null;
  return {
    name: npc.name,
    cls: npc.cls,
    task: npc.task,
    at: npc.at?.name ?? null,
    to: npc.to?.name ?? null,
    t: npc.t,
    wait: npc.wait,
    trailL: npc.trailL,
    flashAt: Number.isFinite(npc.flashAt) ? npc.flashAt : null,
    flight: snapshotFlight(c),
  };
}

/** The game's state as a save, or null when it shouldn't be saved right now (the ship is lost). */
export function snapshotGame(g: Game): SaveData | null {
  if (g.ship.dead) return null;
  return {
    v: SAVE_VERSION,
    savedAt: Date.now(),
    sys: g.cur.sys.id,
    simTime: g.simTime,
    jumpTo: g.jump && g.jump.phase !== 'charge' ? g.jump.dest.id : null,
    ...snapshotFlight(g),
    jumpDest: g.jumpDest?.id ?? null,
    scans: [...g.scans],
    seen: [...g.radar.seen],
    navPoints: g.navPoints.map((s) => s.id),
    navFinal: g.navFinal,
    navMode: g.navMode,
    settings: { lights: g.lights, orbitPreview: g.orbitPreview, radarVisible: g.radarVisible },
    traffic: g.traffic.map(snapshotNpc).filter((n): n is NpcSave => !!n),
  };
}

/** Write the save. Returns false if the browser won't store it (private mode, quota). */
export function saveGame(g: Game) {
  const data = snapshotGame(g);
  if (!data) return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    g.savedAt = data.savedAt;
    return true;
  } catch {
    return false;
  }
}

/** The stored save, if there's a readable one of this version. */
export function readSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    return d && d.v === SAVE_VERSION ? d : null;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* nothing stored, or storage unavailable: nothing to clear */
  }
}

/**
 * Resume from the stored save. Returns false (and leaves the game untouched) when there's none or
 * it doesn't fit this universe any more; the caller then starts a new game.
 */
export function loadGame(g: Game): boolean {
  const d = readSave();
  if (!d) return false;
  const sys = systemById(d.sys);
  if (!sys) return false;
  try {
    restore(g, d, sys);
    return true;
  } catch (e) {
    console.warn('Save could not be restored; starting a new game', e);
    return false;
  }
}

/** Lookups by name in the current system; `need` throws on a name this universe doesn't have. */
function finder(g: Game) {
  const body = (n: string | null) => (n === null ? null : (g.cur.bodies.find((b) => b.name === n) ?? null));
  const station = (n: string | null) => (n === null ? null : (g.cur.stations.find((s) => s.name === n) ?? null));
  const need = <T>(x: T | null, what: string): T => {
    if (x === null) throw new Error(`save names a missing ${what}`);
    return x;
  };
  return { body, station, need };
}

/**
 * Put a saved ship and its flight state into `c` (the game, or a pilot context), in the current
 * system at the current sim time. Vectors are copied into the ship's own (other ships' views share them).
 */
function restoreFlight(c: Game, f: FlightSave) {
  const { ship } = c;
  const { body, station, need } = finder(c);
  const s = f.ship;
  const batt = batteryById(s.outfit.battery);
  if (batt) ship.outfit.battery = batt;
  ship.outfit.slots = s.outfit.slots.map((id) => (id ? moduleById(id) : null));
  ship.outfit.radiatorsOut = s.outfit.radiatorsOut;
  ship.outfit.deploy = s.outfit.deploy;
  ship.outfit.pumpAuto = s.outfit.pumpAuto;
  const unit = (id: string | null) => (id ? (ALL_COMPUTERS.find((u) => u.id === id) ?? null) : null);
  ship.avionics = {
    orbit: unit(s.avionics.orbit) as Avionics['orbit'],
    scanner: unit(s.avionics.scanner) as Avionics['scanner'],
    nav: unit(s.avionics.nav) as Avionics['nav'],
    dock: unit(s.avionics.dock) as Avionics['dock'],
  };
  Object.assign(ship, {
    prop: s.prop, exotic: s.exotic, batt: s.batt, temp: s.temp, vent: s.vent, sunTrack: s.sunTrack,
    fa: s.fa, decoupled: s.decoupled, cruise: s.cruise, throttle: s.throttle, ftlSpeed: s.ftlSpeed, mode: s.mode,
    ftlCharge: 0, tanker: null, dead: null,
  });
  ship.travelDir.copy(V(s.travelDir));
  ship.q.set(s.q[0], s.q[1], s.q[2], s.q[3]).normalize();

  // where it is: relative to its frame body, which the clock has put where it is now
  const fb = need(body(f.frame), 'frame body');
  resetFrame(c, fb);
  ship.pos.copy(fb.pos).add(V(s.rel));
  ship.vel.copy(V(s.vel));
  ship.landed = body(s.landed);

  // what it's doing
  c.dock = f.dock && { station: need(station(f.dock.station), 'station'), pad: f.dock.pad, docked: f.dock.docked };
  c.dockRequest = f.dockRequest && { station: need(station(f.dockRequest.station), 'station'), t: f.dockRequest.t };
  c.autodock = null;
  if (f.autodock) {
    c.autodock = { phase: f.autodock.phase };
    c.autodockStation = need(station(f.autodock.station), 'station');
    c.autodockPad = f.autodock.pad;
    c.dockRel.subVectors(ship.pos, c.autodockStation.pos);
  }
  const dockAt = c.dock?.station ?? c.autodockStation;
  if (dockAt && !c.dock?.docked) startDockGuide(c, dockAt);
  c.refFrame = station(f.refFrame);
  ship.ap = null;
  if (s.ap) {
    const ap = {
      body: need(body(s.ap.body), 'autopilot body'),
      type: s.ap.type,
      station: station(s.ap.station),
      r0: s.ap.r0,
      period: s.ap.period,
      n: s.ap.n && V(s.ap.n),
      point: s.ap.point && V(s.ap.point),
      phase: s.ap.phase,
      settled: s.ap.settled,
      t0: c.simTime,
      prop0: ship.prop,
    };
    if (ap.phase === 'transfer' && ship.mode !== 'ftl') ap.phase = 'insert';
    ship.ap = ap;
    startOrbitGuide(c, ap);
  }
  const t: Target | null = f.target ? (f.target.kind === 'station' ? station(f.target.name) : body(f.target.name)) : null;
  if (t) c.target = t;
}

/** Another ship back as it was; null if it can't be (the save names something that's gone). */
function restoreNpc(g: Game, s: NpcSave): Npc | null {
  const { npc, pilot } = blankNpc(g, s.name, s.cls);
  const { body, station } = finder(g);
  const place = (n: string | null) => station(n) ?? body(n);
  try {
    restoreFlight(pilot, s.flight);
  } catch {
    return null;
  }
  Object.assign(npc, { task: s.task, at: place(s.at), to: place(s.to), t: s.t, wait: s.wait, trailL: s.trailL, flashAt: s.flashAt ?? -Infinity });
  syncNpc(npc);
  return npc;
}

function restore(g: Game, d: SaveData, sys: NonNullable<ReturnType<typeof systemById>>) {
  const { ship } = g;
  // the clock first: loading the system puts every world and station where it is at this time
  g.simTime = d.simTime;
  g.loadSystem(sys);
  restoreFlight(g, d);

  // what you know, and where you were looking
  for (const [k, p] of d.scans) g.scans.set(k, p);
  for (const k of d.seen) g.radar.seen.add(k);
  if (!d.target && d.jumpDest) g.jumpDest = systemById(d.jumpDest);
  g.navPoints = d.navPoints.map(systemById).filter((x): x is NonNullable<typeof x> => !!x);
  g.navFinal = d.navFinal;
  g.navMode = d.navMode;
  g.lights = d.settings.lights;
  g.orbitPreview = d.settings.orbitPreview;
  g.radarVisible = d.settings.radarVisible;
  g.savedAt = d.savedAt;

  // saved mid-jump: the jump completes (and the next system's ships are met afresh)
  if (d.jumpTo) {
    const dest = systemById(d.jumpTo);
    if (dest) {
      arriveAt(g, dest);
      g.showMsg(`Resumed · arrived at ${dest.name}`, 'ftl');
      return;
    }
  }
  // the other ships as they were (loadSystem spawned fresh ones: keep those only for an old save)
  if (d.traffic) g.traffic = d.traffic.map((s) => restoreNpc(g, s)).filter((n): n is Npc => !!n);
  const where = g.dock?.docked ? `docked at ${g.dock.station.name}` : ship.landed ? `landed on ${ship.landed.name}` : `${sys.name}`;
  g.showMsg(`Resumed · ${where} · saved ${ago(d.savedAt)}`);
}

/** "12 s ago", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
