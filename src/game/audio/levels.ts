/**
 * What the ship sounds like right now, read off the game state (docs/sound.md). Pure: no Web
 * Audio here, so it's testable; audio/ShipAudio.ts turns these numbers into sound.
 *
 * Space is silent, so everything is what the pilot hears inside the hull: the drive and the
 * attitude thrusters through the structure, the FTL drive's coils, the laser's power stage, air
 * rushing past only in an atmosphere, and the cockpit's own chimes and alarms.
 */
import { C, FTL_CHARGE_TIME, FTL_MAX, JUMP_CHARGE_TIME, NORMAL_ACC, SHIP } from '../constants';
import type { Game } from '../Game';

/** Continuous layers, each 0…1 unless noted. */
export interface Levels {
  /** Life support and avionics: on while the ship is alive. */
  hum: number;
  /** The main drive (all linear thrust), and how hard it's working (0…1, sets the rumble's brightness). */
  engine: number;
  /** The drive idling in normal space, flying (not docked or landed): its warbling hum. */
  idle: number;
  /** Attitude thrusters: turning. */
  rcs: number;
  /** FTL: charging (0…1 progress, 0 when not charging), running (gain) and its pitch (0…1, with log speed). */
  ftlCharge: number;
  ftl: number;
  ftlPitch: number;
  /** Hyperdrive: charging (0…1 progress) and in transit (departure and the tunnel). */
  jumpCharge: number;
  jump: number;
  /** Air past the hull: loudness (with dynamic pressure) and brightness (with speed, 0…1). */
  wind: number;
  windPitch: number;
  /** The mining laser: firing, and whether it's cutting rock (crackle). */
  laser: number;
  cutting: number;
  /** Dust on the hull in a ring's belt (erosion). */
  grit: number;
  /** Collision radar: a rock on a collision course. */
  proximity: boolean;
}

/** Full drive: the most linear thrust the nozzles take (kW). */
const ENGINE_KW = NORMAL_ACC * SHIP.kwPerAcc;
/** A hard manual turn's attitude-thruster power (kW); gentler turns are quieter. */
const RCS_KW = 20;
/** Dynamic pressure (Pa) at which the wind is full: re-entry, roughly. */
const WIND_Q = 50e3;
/** Hull wear rate (per s) at which the dust's patter is full. */
const GRIT_FULL = 1e-3;

/** Soft knee: small inputs audible, big ones not overwhelming. */
const knee = (x: number) => Math.sqrt(Math.max(0, Math.min(1, x)));

export function soundLevels(g: Game): Levels {
  const { ship, power } = g;
  const alive = !ship.dead;
  const ftl = alive && ship.mode === 'ftl';
  const linKW = Math.max(0, power.thrustKW - power.turnKW);
  const q = 0.5 * g.aero.rho * g.aero.speed * g.aero.speed;
  const j = g.jump;
  return {
    hum: alive ? 1 : 0,
    engine: alive && !ftl ? knee(linKW / ENGINE_KW) : 0,
    idle: alive && !ftl && !g.dock?.docked && !ship.landed ? 1 : 0,
    rcs: alive ? knee(power.turnKW / RCS_KW) : 0,
    ftlCharge: alive && ship.ftlCharge > 0 ? 1 - ship.ftlCharge / FTL_CHARGE_TIME : 0,
    ftl: ftl ? 0.4 + 0.6 * ship.throttle : 0,
    ftlPitch: ftl ? Math.max(0, Math.min(1, Math.log(Math.max(ship.ftlSpeed, C) / C) / Math.log(FTL_MAX / C))) : 0,
    jumpCharge: alive && j?.phase === 'charge' ? 1 - j.t / JUMP_CHARGE_TIME : 0,
    jump: alive && j && j.phase !== 'charge' ? 1 : 0,
    wind: alive && g.aero.body ? knee(Math.log1p(q / 100) / Math.log1p(WIND_Q / 100)) : 0,
    windPitch: Math.min(1, g.aero.speed / 3000),
    laser: alive && g.laser.on && power.laserKW > 0 ? 1 : 0,
    cutting: alive && g.laser.on && g.laser.hit && g.laser.removal > 0 ? 1 : 0,
    grit: alive ? knee(g.erosion / GRIT_FULL) : 0,
    proximity: alive && !!g.rockThreat,
  };
}

/** One-shot sounds, found by comparing this frame's state with the last (ShipAudio plays them). */
export type Cue =
  | { k: 'msg'; kind: '' | 'ftl' | 'warn' }
  | { k: 'impact'; size: number } // size 0…1
  | { k: 'death' }
  | { k: 'ftlIn' }
  | { k: 'ftlOut' }
  | { k: 'granted' }
  | { k: 'docked' }
  | { k: 'launch' }
  | { k: 'catapult' }
  | { k: 'ping' }
  | { k: 'target' };

/** What the last frame looked like, for spotting changes. */
export interface Seen {
  msg: object | null;
  hull: number;
  dead: boolean;
  ftl: boolean;
  dock: object | null;
  docked: boolean;
  ascent: boolean;
  sweep: boolean;
  target: object | null;
}

export const seenNow = (g: Game): Seen => ({
  msg: g.msg,
  hull: g.ship.hull,
  dead: !!g.ship.dead,
  ftl: g.ship.mode === 'ftl',
  dock: g.dock,
  docked: !!g.dock?.docked,
  ascent: !!g.ascent,
  sweep: g.radar.sweep > 0,
  target: g.target,
});

/** Hull lost in one frame (0…1) that makes a full-size bang; less is a smaller knock. */
const BIG_HIT = 0.1;
/** Below this in a frame it's wear (dust, heat), not a knock. */
const MIN_HIT = 0.002;

/** The cues between two frames. A new message only chimes when nothing else says it louder. */
export function cues(was: Seen, now: Seen): Cue[] {
  const out: Cue[] = [];
  if (now.dead && !was.dead) out.push({ k: 'death' });
  else if (!now.dead && was.hull - now.hull > MIN_HIT && !was.dead) out.push({ k: 'impact', size: Math.min(1, (was.hull - now.hull) / BIG_HIT) });
  if (now.ftl && !was.ftl) out.push({ k: 'ftlIn' });
  if (!now.ftl && was.ftl && !now.dead) out.push({ k: 'ftlOut' });
  if (now.docked && !was.docked) out.push({ k: 'docked' });
  else if (now.dock && !now.docked && now.dock !== was.dock && !was.docked) out.push({ k: 'granted' });
  if (!now.docked && was.docked && !now.dead) out.push(now.ascent ? { k: 'catapult' } : { k: 'launch' });
  if (now.sweep && !was.sweep) out.push({ k: 'ping' });
  if (out.length === 0 && now.msg !== was.msg && now.msg) out.push({ k: 'msg', kind: (now.msg as { kind: '' | 'ftl' | 'warn' }).kind });
  if (now.target !== was.target && now.target) out.push({ k: 'target' });
  return out;
}
