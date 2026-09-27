/*
 * Outfitting: modules go in or come out only alongside a station, in its local frame and nearly
 * at rest relative to it (a yard crew does the work). No prices yet: every module is available.
 */
import type { Game } from '../Game';
import { relVel } from '../sim/frame';
import type { Station } from '../types';
import { batteryById, moduleById, moduleLabel, radiatorsFitted } from './catalog';

/** Slowest relative speed (m/s) at which a station will work on the ship. */
export const OUTFIT_MAX_SPEED = 50;

/** The station that can outfit the ship right now, if any. */
export function outfitter(g: Game): Station | null {
  if (!g.refFrame || g.ship.mode !== 'normal') return null;
  return relVel(g).length() <= OUTFIT_MAX_SPEED ? g.refFrame : null;
}

export function fitModule(g: Game, slot: number, id: string) {
  const st = outfitter(g),
    m = moduleById(id),
    o = g.ship.outfit;
  if (!st || !m || slot < 0 || slot >= o.slots.length) return;
  if (m.kind === 'heatpump' && o.slots.some((x, i) => i !== slot && x?.kind === 'heatpump')) {
    g.showMsg('One heat pump is enough: it drives every radiator', 'warn');
    return;
  }
  o.slots[slot] = m;
  g.showMsg(`${st.name} · fitted ${moduleLabel(m)} in slot ${slot + 1}`);
}

export function removeModule(g: Game, slot: number) {
  const st = outfitter(g),
    o = g.ship.outfit,
    m = o.slots[slot];
  if (!st || !m) return;
  o.slots[slot] = null;
  if (!radiatorsFitted(o).length) {
    o.deploy = false;
    o.radiatorsOut = 0;
  }
  g.showMsg(`${st.name} · removed ${moduleLabel(m)}`);
}

/** Swap the battery. The yard installs the new pack fully charged (and keeps the old one). */
export function fitBattery(g: Game, id: string) {
  const st = outfitter(g),
    b = batteryById(id),
    o = g.ship.outfit;
  if (!st || !b || b === o.battery) return;
  o.battery = b;
  g.ship.batt = b.caps.capacity;
  g.showMsg(`${st.name} · fitted ${moduleLabel(b)} battery · ${b.caps.capacity} kWh, charged`);
}
