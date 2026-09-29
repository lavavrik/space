/*
 * Outfitting: modules go in or come out only while docked at a station (sim/docking.ts). Fitting one
 * costs its price there (list × the station's factor: sim/economy.ts); one taken out, or replaced, is
 * bought back at half its list price. Every module is on sale everywhere.
 */
import type { Game } from '../Game';
import type { Station } from '../types';
import { PRICE, fmtCr, pay, stationFactor } from '../sim/economy';
import { batteryById, moduleById, moduleLabel, radiatorsFitted } from './catalog';

/** What fitting a module of list `price` costs at `st`. */
export const fitPrice = (st: Station | null, price: number) => price * stationFactor(st, 'module');

/** The station that can outfit the ship right now (the one it's docked at), if any. */
export function outfitter(g: Game): Station | null {
  return g.dock?.docked ? g.dock.station : null;
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
  const old = o.slots[slot];
  const cost = fitPrice(st, m.price) - (old ? old.price * PRICE.buyBack : 0);
  if (!pay(g, cost, moduleLabel(m))) return;
  o.slots[slot] = m;
  g.showMsg(`${st.name} · fitted ${moduleLabel(m)} in slot ${slot + 1} · ${cost >= 0 ? fmtCr(cost) : `${fmtCr(-cost)} back`}`);
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
  const back = m.price * PRICE.buyBack;
  g.credits += back;
  g.showMsg(`${st.name} · removed ${moduleLabel(m)} · bought back for ${fmtCr(back)}`);
}

/** Swap the battery. The yard installs the new pack fully charged (and keeps the old one). */
export function fitBattery(g: Game, id: string) {
  const st = outfitter(g),
    b = batteryById(id),
    o = g.ship.outfit;
  if (!st || !b || b === o.battery) return;
  const cost = fitPrice(st, b.price) - o.battery.price * PRICE.buyBack;
  if (!pay(g, cost, moduleLabel(b))) return;
  o.battery = b;
  g.ship.batt = b.caps.capacity;
  g.showMsg(`${st.name} · fitted ${moduleLabel(b)} battery · ${b.caps.capacity} kWh, charged · ${cost >= 0 ? fmtCr(cost) : `${fmtCr(-cost)} back`}`);
}
