/*
 * Radar: a built-in sensor every ship has. It works in sweeps: "scan" (radar window, Shift+Y)
 * runs a SWEEP-second sweep that draws RADAR_KW, and picks up everything within RADAR_RANGE. What
 * it finds is remembered (per system, as scan keys); between sweeps it draws nothing, and the
 * window shows the remembered objects at their current, predicted positions (their orbits are
 * known once they're tracked).
 *
 * It only tells you what's there: how far, and what kind of thing (a star, a gas or ice giant, a
 * rocky world, a moon, a station, a ship). Ships are tracked from then on as they move. Names and
 * details still take the scanner (Y; "identify" in the
 * window). The navigation search only offers what the radar has found in this system.
 */
import { AU, WT } from '../constants';
import type { Game } from '../Game';
import type { Target } from '../types';
import { grant } from './power';
import { SCAN_STAGE, scanKey, scanProgress } from './scanner';
import { prospect } from './prospect';
import { fmtCr } from './economy';
import { rockLabel } from './ringRocks';

export const RADAR_RANGE = 10 * AU;
export const RADAR_KW = 400;
/** Seconds a sweep takes (at full power). */
export const SWEEP = 4;

export interface Contact {
  target: Target;
  key: string;
  dist: number; // m to its surface (or a station's hull)
}

/** The broad class the radar can tell from a return: size and whether it shines. */
export function radarClass(t: Target) {
  if (t.kind === 'station') return 'station';
  if (t.kind === 'ship') return 'ship';
  if (t.kind === 'wreck') return 'wreck';
  if (t.kind === 'lpoint') return 'Lagrange point';
  if (t.kind === 'star') return 'star';
  if (t.kind === 'moon') return 'moon';
  return t.type === WT.GasGiant ? 'gas giant' : t.type === WT.IceGiant ? 'ice giant' : 'rocky world';
}

/**
 * What the HUD calls an object: its name once the scanner has identified it, else its class. The
 * system's star is always known by name (it's on the star map).
 */
export function contactLabel(g: Game, t: Target) {
  if (t.kind === 'wreck' || t.kind === 'lpoint') return t.name; // its beacon says what it is; a point is named for its planet
  if (t.kind === 'ship') return scanProgress(g, t) >= SCAN_STAGE.type ? `${t.cls} ${t.name}` : radarSeen(g, t) ? 'Unidentified ship' : 'Unknown object';
  if (t.kind === 'star' || scanProgress(g, t) >= SCAN_STAGE.type) return t.name;
  // before the radar has it, all we know is that something's there (e.g. a disc we clicked)
  return radarSeen(g, t) ? `Unidentified ${radarClass(t)}` : 'Unknown object';
}

/** Does the HUD know about this object (the system's star, or anything the radar has found)? */
export const known = (g: Game, t: Target): boolean => t.kind === 'star' || t.kind === 'wreck' || (t.kind === 'lpoint' ? known(g, t.planet) : radarSeen(g, t));

/** Has the radar ever picked this up (in the current system)? */
export const radarSeen = (g: Game, t: Target) => g.radar.seen.has(scanKey(g.cur.sys, t));

/** Everything the radar has found in this system, nearest first (live distances). */
export function radarContacts(g: Game): Contact[] {
  const out: Contact[] = [];
  for (const t of [...g.cur.bodies, ...g.cur.stations, ...g.traffic]) {
    const key = scanKey(g.cur.sys, t);
    if (!g.radar.seen.has(key)) continue;
    const d = t.pos.distanceTo(g.ship.pos) - (t.kind === 'station' ? t.size / 2 : t.radius);
    out.push({ target: t, key, dist: Math.max(0, d) });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** Each frame: run the sweep in progress (drawing power) and log what it finds when it completes. Call after beginPower. */
export function updateRadar(g: Game, dt: number) {
  const r = g.radar;
  g.power.radarKW = 0;
  if (r.sweep <= 0) return;
  const kw = g.ship.breakers.radar ? grant(g, RADAR_KW, 'radar') : 0; // switched off mid-sweep: it pauses
  g.power.radarKW = kw;
  r.sweep -= (dt * kw) / RADAR_KW; // a weak bus makes the sweep slower
  if (r.sweep > 0) return;
  r.sweep = 0;
  let n = 0;
  for (const t of [...g.cur.bodies, ...g.cur.stations, ...g.traffic]) {
    const d = t.pos.distanceTo(g.ship.pos) - (t.kind === 'station' ? t.size / 2 : t.radius);
    if (d > RADAR_RANGE) continue;
    const key = scanKey(g.cur.sys, t);
    if (!r.seen.has(key)) n++;
    r.seen.add(key);
  }
  // in a belt, it prospects too: the best metal-rich rocks around (sim/prospect.ts)
  r.rocks = prospect(g);
  const best = r.rocks[0];
  const rocks = best ? ` · ${r.rocks.length} metal-rich rock${r.rocks.length > 1 ? 's' : ''} marked, best a ${rockLabel(best.size)} ${best.kind} (~${fmtCr(best.perHour)}/h)` : '';
  g.showMsg(`Radar sweep complete · ${n ? `${n} new contact${n > 1 ? 's' : ''}` : 'nothing new'} within ${RADAR_RANGE / AU} AU${rocks}`);
  g.invalidateHud();
}

/** Start a sweep. */
export function radarSweep(g: Game) {
  const r = g.radar;
  if (r.sweep > 0) return;
  if (!g.ship.breakers.radar) {
    g.showMsg('The radar is switched off · ship stats (U), power', 'warn');
    return;
  }
  r.sweep = SWEEP;
  g.showMsg(`Radar sweeping · ${RADAR_RANGE / AU} AU · ${RADAR_KW} kW for ${SWEEP} s`);
}
