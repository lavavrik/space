/*
 * Radar: a built-in sensor every ship has. While it's on it draws RADAR_KW and sweeps everything
 * within RADAR_RANGE every SWEEP seconds. It only tells you what's there: how far, and what kind of
 * thing (a star, a gas or ice giant, a rocky world, a moon, a station). Names and details still take
 * the scanner (Y), which the radar window can start on any contact.
 *
 * Anything it has ever picked up in a system stays known ("seen"), and that's what the navigation
 * search offers in this system: you can't plot a course to something you haven't detected.
 */
import { AU, WT } from '../constants';
import type { Game } from '../Game';
import type { Target } from '../types';
import { grant } from './power';
import { SCAN_STAGE, scanKey, scanProgress } from './scanner';

export const RADAR_RANGE = 10 * AU;
export const RADAR_KW = 150;
/** Seconds between sweeps. */
const SWEEP = 2;

export interface Contact {
  target: Target;
  key: string;
  dist: number; // m to its surface (or a station's hull)
}

/** The broad class the radar can tell from a return: size and whether it shines. */
export function radarClass(t: Target) {
  if (t.kind === 'station') return 'station';
  if (t.kind === 'star') return 'star';
  if (t.kind === 'moon') return 'moon';
  return t.type === WT.GasGiant ? 'gas giant' : t.type === WT.IceGiant ? 'ice giant' : 'rocky world';
}

/**
 * What the HUD calls an object: its name once the scanner has identified it, else its class. The
 * system's star is always known by name (it's on the star map).
 */
export function contactLabel(g: Game, t: Target) {
  return t.kind === 'star' || scanProgress(g, t) >= SCAN_STAGE.type ? t.name : `Unidentified ${radarClass(t)}`;
}

/** Has the radar ever picked this up (in the current system)? */
export const radarSeen = (g: Game, t: Target) => g.radar.seen.has(scanKey(g.cur.sys, t));

/** Each frame: draw power while on, and sweep every SWEEP seconds. Call after beginPower. */
export function updateRadar(g: Game, dt: number) {
  const r = g.radar;
  g.power.radarKW = 0;
  if (!r.on) {
    r.contacts = [];
    return;
  }
  const kw = grant(g, RADAR_KW, 'radar');
  g.power.radarKW = kw;
  if (kw < RADAR_KW * 0.5) {
    r.on = false;
    r.contacts = [];
    g.showMsg('Radar off · not enough power', 'warn');
    return;
  }
  r.t -= dt;
  if (r.t > 0) return;
  r.t = SWEEP;
  const { ship } = g;
  const found: Contact[] = [];
  for (const t of [...g.cur.bodies, ...g.cur.stations]) {
    const d = t.pos.distanceTo(ship.pos) - (t.kind === 'station' ? t.size / 2 : t.radius);
    if (d > RADAR_RANGE) continue;
    const key = scanKey(g.cur.sys, t);
    found.push({ target: t, key, dist: Math.max(0, d) });
    r.seen.add(key);
  }
  r.contacts = found.sort((a, b) => a.dist - b.dist);
  g.invalidateHud();
}

/** Switch the radar on or off. */
export function toggleRadar(g: Game) {
  const r = g.radar;
  r.on = !r.on;
  r.t = 0; // sweep straight away
  if (!r.on) r.contacts = [];
  g.showMsg(r.on ? `Radar on · ${RADAR_RANGE / AU} AU · ${RADAR_KW} kW` : 'Radar off');
}
