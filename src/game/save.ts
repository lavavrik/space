/*
 * Saving and resuming (docs/saving.md). One save, in the browser's localStorage, written every
 * AUTOSAVE_S seconds and whenever the page is hidden or closed, and read when the game starts.
 *
 * The universe is generated from seeds, so a save only needs what the player changed: which system
 * you're in and the sim clock (every world's orbit and spin, and every station's, follow from it),
 * the ship (where it is relative to its frame body, its motion, tanks, heat, fitted modules and
 * computers), what it's doing (docked, a docking request, the docking computer, the autopilot, a
 * hyperjump), what you've found and scanned, the target, and a few settings.
 *
 * Objects are saved by name or id: bodies and stations by name within the system, systems by id,
 * modules and computers by catalog id. Not saved: other ships (sim/traffic.ts spawns them afresh),
 * a nav route in flight (its waypoints are kept; engage it again), a tanker on its way, the orbit
 * planner, a scan in progress. A hyperjump under way is saved as its destination: you arrive there.
 * A lost ship isn't saved (the last save stands).
 */
import type { Game } from './Game';
import { THREE } from './lib/three';
import { ALL_COMPUTERS, type Avionics } from './avionics/catalog';
import { batteryById, moduleById } from './outfit/catalog';
import type { ApType, Target } from './types';
import { systemById } from './universe/galaxy';
import { resetFrame } from './sim/frame';
import { arriveAt } from './sim/navigation';
import { startDockGuide, startOrbitGuide } from './sim/guide';
import type { AutoPhase } from './sim/autodock';
import type { NavMode } from './sim/navroute';

/** localStorage key; bump the version when the format changes incompatibly (old saves are ignored). */
export const SAVE_KEY = 'farlight.save';
export const SAVE_VERSION = 1;
/** Seconds of real time between autosaves. */
export const AUTOSAVE_S = 15;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** What's written (JSON). */
export interface SaveData {
  v: number;
  savedAt: number; // wall clock, ms
  sys: string; // system id
  simTime: number;
  jumpTo: string | null; // a hyperjump under way: its destination (you arrive there on load)
  frame: string; // frame body's name
  ship: {
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
  };
  dock: { station: string; pad: number; docked: boolean } | null;
  dockRequest: { station: string; t: number } | null;
  autodock: { phase: AutoPhase; station: string; pad: number } | null;
  refFrame: string | null;
  target: { kind: 'body' | 'station'; name: string } | null;
  jumpDest: string | null;
  scans: [string, number][];
  seen: string[];
  navPoints: string[];
  navFinal: Game['navFinal'];
  navMode: NavMode;
  settings: { lights: boolean; orbitPreview: boolean; radarVisible: boolean };
}

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const V = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** The game's state as a save, or null when it shouldn't be saved right now (the ship is lost). */
export function snapshotGame(g: Game): SaveData | null {
  const { ship } = g;
  if (ship.dead) return null;
  const fb = g.frameBody;
  const ap = ship.ap;
  const t = g.target;
  return {
    v: SAVE_VERSION,
    savedAt: Date.now(),
    sys: g.cur.sys.id,
    simTime: g.simTime,
    jumpTo: g.jump && g.jump.phase !== 'charge' ? g.jump.dest.id : null,
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
    dock: g.dock && { station: g.dock.station.name, pad: g.dock.pad, docked: g.dock.docked },
    dockRequest: g.dockRequest && { station: g.dockRequest.station.name, t: g.dockRequest.t },
    autodock: g.autodock && g.autodockStation ? { phase: g.autodock.phase, station: g.autodockStation.name, pad: g.autodockPad } : null,
    refFrame: g.refFrame?.name ?? null,
    target: t && t.kind !== 'ship' ? { kind: t.kind === 'station' ? 'station' : 'body', name: t.name } : null,
    jumpDest: g.jumpDest?.id ?? null,
    scans: [...g.scans],
    seen: [...g.radar.seen],
    navPoints: g.navPoints.map((s) => s.id),
    navFinal: g.navFinal,
    navMode: g.navMode,
    settings: { lights: g.lights, orbitPreview: g.orbitPreview, radarVisible: g.radarVisible },
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

function restore(g: Game, d: SaveData, sys: NonNullable<ReturnType<typeof systemById>>) {
  const { ship } = g;
  // the clock first: loading the system puts every world and station where it is at this time
  g.simTime = d.simTime;
  g.loadSystem(sys);
  const bodyNamed = (n: string | null) => (n === null ? null : (g.cur.bodies.find((b) => b.name === n) ?? null));
  const stationNamed = (n: string | null) => (n === null ? null : (g.cur.stations.find((s) => s.name === n) ?? null));
  const need = <T>(x: T | null, what: string): T => {
    if (x === null) throw new Error(`save names a missing ${what}`);
    return x;
  };

  // the ship's gear
  const s = d.ship;
  const batt = batteryById(s.outfit.battery);
  if (batt) ship.outfit.battery = batt;
  ship.outfit.slots = s.outfit.slots.map((id) => (id ? moduleById(id) : null));
  ship.outfit.radiatorsOut = s.outfit.radiatorsOut;
  ship.outfit.deploy = s.outfit.deploy;
  ship.outfit.pumpAuto = s.outfit.pumpAuto;
  const unit = (id: string | null) => (id ? (ALL_COMPUTERS.find((c) => c.id === id) ?? null) : null);
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

  // where it is: relative to its frame body, which has moved to where the clock puts it
  const fb = need(bodyNamed(d.frame), 'frame body');
  resetFrame(g, fb);
  ship.pos.copy(fb.pos).add(V(s.rel));
  ship.vel.copy(V(s.vel));
  ship.landed = bodyNamed(s.landed);

  // what it's doing
  if (d.dock) g.dock = { station: need(stationNamed(d.dock.station), 'station'), pad: d.dock.pad, docked: d.dock.docked };
  if (d.dockRequest) g.dockRequest = { station: need(stationNamed(d.dockRequest.station), 'station'), t: d.dockRequest.t };
  if (d.autodock) {
    g.autodock = { phase: d.autodock.phase };
    g.autodockStation = need(stationNamed(d.autodock.station), 'station');
    g.autodockPad = d.autodock.pad;
    g.dockRel.subVectors(ship.pos, g.autodockStation.pos);
  }
  const dockAt = g.dock?.station ?? g.autodockStation;
  if (dockAt && !g.dock?.docked) startDockGuide(g, dockAt);
  g.refFrame = stationNamed(d.refFrame);
  if (s.ap) {
    const ap = {
      body: need(bodyNamed(s.ap.body), 'autopilot body'),
      type: s.ap.type,
      station: stationNamed(s.ap.station),
      r0: s.ap.r0,
      period: s.ap.period,
      n: s.ap.n && V(s.ap.n),
      point: s.ap.point && V(s.ap.point),
      phase: s.ap.phase,
      settled: s.ap.settled,
      t0: g.simTime,
      prop0: ship.prop,
    };
    if (ap.phase === 'transfer' && ship.mode !== 'ftl') ap.phase = 'insert';
    ship.ap = ap;
    startOrbitGuide(g, ap);
  }

  // what you know, and where you were looking
  for (const [k, p] of d.scans) g.scans.set(k, p);
  for (const k of d.seen) g.radar.seen.add(k);
  const t: Target | null = d.target ? (d.target.kind === 'station' ? stationNamed(d.target.name) : bodyNamed(d.target.name)) : null;
  if (t) g.target = t;
  else if (d.jumpDest) g.jumpDest = systemById(d.jumpDest);
  g.navPoints = d.navPoints.map(systemById).filter((x): x is NonNullable<typeof x> => !!x);
  g.navFinal = d.navFinal;
  g.navMode = d.navMode;
  g.lights = d.settings.lights;
  g.orbitPreview = d.settings.orbitPreview;
  g.radarVisible = d.settings.radarVisible;
  g.savedAt = d.savedAt;

  // saved mid-jump: the jump completes
  if (d.jumpTo) {
    const dest = systemById(d.jumpTo);
    if (dest) {
      arriveAt(g, dest);
      g.showMsg(`Resumed · arrived at ${dest.name}`, 'ftl');
      return;
    }
  }
  const where = g.dock?.docked ? `docked at ${g.dock.station.name}` : ship.landed ? `landed on ${ship.landed.name}` : `${sys.name}`;
  g.showMsg(`Resumed · ${where} · saved ${ago(d.savedAt)}`);
}

/** "12 s ago", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
