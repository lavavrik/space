/*
 * Scanner (the fitted Argus Optics unit). An object can be scanned only when its angular size,
 * 2R / distance, is at least the unit's resolution: a basic scanner has to get close to anything
 * small. Scanning the current target (Y) takes a few seconds and reveals it in stages:
 *   ≥ 25 %  type and size          ≥ 50 %  mass, gravity, escape velocity
 *   ≥ 75 %  its orbit              100 %   climate, atmosphere, rings, moons, stations
 * Progress is kept per object for the session. The home system starts fully scanned.
 */
import { fmtDist } from '../format';
import type { Game } from '../Game';
import type { StarSystem, Target } from '../types';
import { HOME_ID } from '../universe/galaxy';
import { contactLabel } from './radar';

export const SCAN_STAGE = { type: 0.25, physical: 0.5, orbit: 0.75, full: 1 } as const;
/** Seconds for a baseline (1×) scanner to scan something comfortably above its resolution. */
const SCAN_BASE_TIME = 5;

/** Stable key for an object: system id plus name (names are unique within a system). */
export function scanKey(sys: StarSystem, t: Target) {
  return `${sys.id}/${t.kind === 'station' ? 'st:' : ''}${t.name}`;
}

/** How much of `t` has been scanned, 0…1. */
export function scanProgress(g: Game, t: Target) {
  if (g.cur.sys.id === HOME_ID) return 1; // you know your home system
  return g.scans.get(scanKey(g.cur.sys, t)) ?? 0;
}

/** Physical radius the scanner has to resolve (a station is resolved by its cube's size). */
const scanRadius = (t: Target) => (t.kind === 'station' ? t.size / 2 : t.radius);

/** Whether the fitted scanner can resolve `t` from here, and how close it would need to be. */
export function resolvable(g: Game, t: Target) {
  const sc = g.ship.avionics.scanner;
  const d = Math.max(1, t.pos.distanceTo(g.ship.pos));
  const size = (2 * scanRadius(t)) / d; // rad
  const res = sc ? sc.caps.resolution : Infinity;
  return { ok: size >= res, size, res, needDist: (2 * scanRadius(t)) / res };
}

/** Y: start (or stop) scanning the current target. */
export function toggleScan(g: Game) {
  const sc = g.ship.avionics.scanner;
  const t = g.target;
  if (!sc) return g.showMsg('No scanner fitted · see avionics (U)', 'warn');
  if (!t) return g.showMsg('Target something to scan (T, G or click)', 'warn');
  if (g.scanning === t) {
    g.scanning = null;
    return g.showMsg('Scan paused');
  }
  if (scanProgress(g, t) >= 1) return g.showMsg(`${t.name} is already scanned · I for details`);
  const r = resolvable(g, t);
  const label = contactLabel(g, t);
  if (!r.ok) return g.showMsg(`${sc.model} can't resolve ${label} from here · close to ${fmtDist(r.needDist)}`, 'warn');
  g.scanning = t;
  g.showMsg(`Scanning ${label}…`);
}

/** Advance the scan of the current target; pauses (with a message) if it drops out of resolution. */
export function updateScan(g: Game, dt: number) {
  const t = g.scanning;
  if (!t) return;
  const sc = g.ship.avionics.scanner;
  // the scanner follows the target: switching targets (or losing the scanner) stops the scan
  if (!sc || g.target !== t) return void (g.scanning = null);
  const r = resolvable(g, t);
  if (!r.ok) {
    g.scanning = null;
    g.showMsg(`Lost resolution on ${contactLabel(g, t)} · close to ${fmtDist(r.needDist)}`, 'warn');
    return;
  }
  // near the resolution limit the scan takes up to 3× longer
  const time = (SCAN_BASE_TIME * (1 + 2 * Math.min(1, r.res / r.size))) / sc.caps.rate;
  const key = scanKey(g.cur.sys, t);
  const p = Math.min(1, (g.scans.get(key) ?? 0) + dt / time);
  g.scans.set(key, p);
  if (p >= 1) {
    g.scanning = null;
    g.showMsg(`Scan complete · ${t.name} · I for details`);
    g.invalidateHud();
  }
}
