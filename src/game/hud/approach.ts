/*
 * The target card's approach strip: a line from far away (left) to the target's surface or hull
 * (right), with the ship on it and the milestones of an approach marked: where FTL locks and drops
 * out, where the gravity well takes over, the lowest safe orbit, the air, the scoop zones, where
 * flight assist starts following the ground or slowing you, and for stations where you can ask for
 * a pad, where the docking computer can take over, and so on.
 *
 * Scale: distance d (m to the surface) maps to x = 0.1 + 0.9 · (1 − log(1 + d/d0) / log(1 + D/d0))
 * with d0 = D/1000: logarithmic, so the milestones hundreds of km out and the last kilometres both
 * get room; only the last 0.1% of the window is near-linear.
 * The window D is 2^k, the smallest power of two past 1.5× the ship's distance (and never so small
 * that it hides the target itself): as you close in it zooms in steps, which the UI animates.
 * Milestones beyond D aren't dropped: the leftmost 10% is an "outside" zone where everything from D
 * to infinity is squeezed (x = 0.1 · D/d), dimmed, so you can still see what's ahead of the window.
 */
import { ARRIVE_FLUX, NORMAL_MAX, SCOOP_FLUX_FULL, SCOOP_FLUX_MIN, WT, fluxDist } from '../constants';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { HOLD_OUT } from '../sim/autodock';
import { DOCK_REQUEST_RANGE } from '../sim/docking';
import { CLEARANCE, SURF_K } from '../sim/flight';
import { FRAME_ENTER, SURFACE_FRAME_ALT, TARGET_FRAME_ENTER } from '../sim/frame';
import { dropAlt } from '../sim/ftl';
import { minOrbitAlt } from '../sim/orbits';
import { reliefAmp } from '../sim/terrain';
import type { Target } from '../types';
import type { ApproachMark, ApproachView } from './types';

/** Width of the outside zone (fraction of the strip). */
const OUT = 0.1;
/** Label width per letter, and where labels flip to the tick's left (fractions of the strip; Hud.tsx). */
const LABEL_W = 0.026,
  FLIP_X = 0.85;

type Raw = Omit<ApproachMark, 'x' | 'row' | 'outside'>;

/** The milestones of an approach to `t` (distances to its surface or hull, m). */
function milestones(g: Game, t: Target): Raw[] {
  const out: Raw[] = [];
  const add = (d: number, label: string, detail: string, kind: ApproachMark['kind']) => {
    if (d > 0 && Number.isFinite(d)) out.push({ d, label, detail, kind });
  };
  if (t.kind === 'station') {
    add(TARGET_FRAME_ENTER, 'FRAME', 'Flight assist and speed work relative to the station (as your target)', 'info');
    const unit = g.ship.avionics.dock;
    if (unit?.caps.clearance) add(unit.caps.range, 'AUTO', `${unit.model} can fly you in from here (K)`, 'ftl');
    add(FRAME_ENTER, 'NEAR', 'Station frame even when not targeted', 'info');
    add(DOCK_REQUEST_RANGE, 'PAD', 'Close enough to request a pad from traffic control (K)', 'on');
    add(HOLD_OUT, 'HOLD', 'Approach hold point on the slot axis', 'info');
    return out;
  }
  const b = t;
  if (b.kind !== 'star') add(b.soi - b.radius, 'SOI', `${b.name}'s gravity dominates: its frame and orbits from here`, 'info');
  add(dropAlt(b) * 1.15, 'LOCK', "Mass lock: FTL can't be engaged closer", 'warn');
  add(dropAlt(b), 'DROP', 'FTL drops out here', 'ftl');
  if (b.kind === 'star') {
    add(fluxDist(b.L, ARRIVE_FLUX, b.radius) - b.radius, 'ARRIVE', 'Where hyperjumps arrive (20× Earth’s sunlight)', 'info');
    add(fluxDist(b.L, SCOOP_FLUX_MIN, b.radius) - b.radius, 'SCOOP', 'Corona scoop starts working (25× Earth’s sunlight)', 'on');
    add(fluxDist(b.L, SCOOP_FLUX_FULL, b.radius) - b.radius, 'FULL', 'Corona scoop at its full rate (100×)', 'on');
    return out;
  }
  add(minOrbitAlt(b), 'ORBIT', 'Lowest safe orbit', 'info');
  if (b.pal.atmo) add(b.radius * 0.025, 'AIR', 'Top of the atmosphere', 'info');
  if (b.type >= WT.GasGiant) add(b.radius * 0.05, 'SCOOP', 'Fuel scoop works below this (skimming the upper atmosphere)', 'on');
  if (reliefAmp(b) > 0) {
    add(SURFACE_FRAME_ALT, 'GROUND', 'Flight assist starts following the turning ground', 'info');
    add(NORMAL_MAX / SURF_K + CLEARANCE, 'SLOW', 'Flight assist caps your speed by height from here', 'warn');
  }
  return out;
}

export function approachView(g: Game, t: Target, d: number): ApproachView {
  const raw = milestones(g, t);
  const size = t.kind === 'station' ? t.size : t.radius;
  // the window: a power of two past 1.5× the ship's distance, at least a few target sizes
  const D = 2 ** Math.ceil(Math.log2(Math.max(d * 1.5, size * 0.05, 100)));
  const d0 = D / 1000;
  const x = (dd: number) => (dd <= D ? OUT + (1 - OUT) * (1 - Math.log1p(dd / d0) / Math.log1p(D / d0)) : OUT * (D / dd));
  const marks: ApproachMark[] = raw
    .sort((a, b) => b.d - a.d)
    .map((m) => ({ ...m, detail: `${m.detail} · ${fmtDist(m.d)}`, x: x(m.d), row: 0, outside: m.d > D }));
  // labels: two rows above the line, a label where it fits; the rest keep their tick (and tooltip).
  // A label runs right of its tick (left of it past FLIP_X), about LABEL_W of the strip per letter.
  const end = [-1, -1];
  for (const m of marks) {
    const w = m.label.length * LABEL_W;
    const [a, b] = m.x > FLIP_X ? [m.x - w, m.x] : [m.x, m.x + w];
    const free = [0, 1].find((r) => a > end[r] + 0.01);
    m.row = free ?? -1;
    if (free !== undefined) end[free] = b;
  }
  return { shipX: x(Math.max(0, d)), marks, scale: fmtDist(D) };
}
