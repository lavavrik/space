/**
 * Oxygen (docs/power.md, "Oxygen and fuel cells"): a tank of liquid oxygen (LOX, 90 K, 1.14 kg/L)
 * that life support breathes from and a fuel cell burns hydrogen with.
 *
 *   - Life support: LIFE_O2 for a crew of four with ISS-style recycling (a person breathes
 *     ~0.84 kg/day; about half is won back from the CO₂). Docked, the station supplies the air.
 *     Empty, it's fatal: warned well before.
 *   - Fuel cell (a module, like the Shuttle's): H₂ + ½O₂ → water and electricity at FC_EFF of
 *     hydrogen's heating value (33.3 kWh/kg), so FC_KWH per kg of H₂, with O2_PER_H2 kg of oxygen
 *     each; the rest is heat in the hull. Automatic: it starts when the battery falls below FC_ON
 *     and stops once it's back over FC_OFF, covering the loads and recharging the battery as far as
 *     its rating goes. It has its own switch (the power schematic).
 *   - Electrolyser: splitting water costs ELECTROLYSIS_KWH per kg of oxygen won (~50 kWh per kg of
 *     hydrogen). It runs while there's water coming in (the laser boiling ice, or mining ice on the
 *     ground) and room in the tank, on spare power only: never taking the battery below half.
 *   - Air: skimming an Earth-like world's atmosphere with the fuel scoop, its oxygen (O2_IN_AIR of
 *     the air by mass) is caught and liquefied: in proportion to the air's density and your speed
 *     through it, so the richest pickings are low and fast, where the heating is too.
 *   - Stations sell it (the station window, Services).
 *
 * (The scoop's hydrogen from ice isn't charged the electrolysis energy it would really need: the
 * propellant yields were tuned for play before oxygen existed. Oxygen is charged in full.)
 */
import { SHIP } from '../constants';
import type { Game } from '../Game';
import { fmtTime } from '../format';
import { fuelCellFitted, scoopFitted } from '../outfit/catalog';
import { WT } from '../constants';
import { battCap, grant, loadOn } from './power';

/** kg of oxygen life support uses per second (2 kg/day). */
export const LIFE_O2 = 2 / 86400;
/** Fuel cell: share of hydrogen's heating value that comes out as electricity; kWh per kg of H₂; kg of O₂ per kg of H₂. */
export const FC_EFF = 0.55,
  FC_KWH = 33.3 * FC_EFF,
  O2_PER_H2 = 7.94;
/** It starts below this share of the battery and stops over this. */
export const FC_ON = 0.3,
  FC_OFF = 0.8;
/** Electrolysis: kWh per kg of oxygen split from water; the electrolyser's rating (kW). */
export const ELECTROLYSIS_KWH = 6.3,
  ELECTROLYSER_KW = 300;
/** Oxygen's share of air by mass. */
export const O2_IN_AIR = 0.23;
/** The scoop's intake for air (m², × the scoop's rate). */
const AIR_INTAKE = 10;

/** Days of breathing the tank holds. */
export const o2Days = (kg: number) => kg / LIFE_O2 / 86400;

/**
 * The fuel cell's share of this frame's power (kW), before the loads are granted: its full rating
 * while it runs (with hydrogen and oxygen to burn), else 0. What's actually used is settled after
 * (settleFuelCell), and only that is burned.
 */
export function fuelCellOffer(g: Game) {
  const { ship, power } = g;
  const fc = fuelCellFitted(ship.outfit);
  if (!fc || !loadOn(g, 'fuelcell') || ship.prop <= 0 || ship.o2 <= 0) {
    power.fcOn = false;
    return 0;
  }
  const f = ship.batt / battCap(ship);
  if (!power.fcOn && f < FC_ON) {
    power.fcOn = true;
    g.showMsg(`Battery under ${FC_ON * 100} % · ${fc.model} fuel cell running (H₂ + O₂)`);
  } else if (power.fcOn && f > FC_OFF) power.fcOn = false;
  return power.fcOn ? fc.caps.kw : 0;
}

/**
 * After the loads: what the fuel cell actually gives (the loads' shortfall from the panels and shore,
 * plus what the battery can take, up to its rating), and the hydrogen and oxygen that burns.
 * Returns its output (kW).
 */
export function settleFuelCell(g: Game, dt: number, offer: number) {
  const { ship, power } = g;
  if (offer <= 0 || dt <= 0) {
    power.fcKW = 0;
    return 0;
  }
  const b = ship.outfit.battery.caps;
  const room = ship.batt < b.capacity ? b.chargeKW : 0;
  let kw = Math.min(offer, Math.max(0, power.draw - power.solar - power.shore) + room);
  // limited by what's in the tanks
  const h2 = (kw * dt) / 3600 / FC_KWH;
  const scale = Math.min(1, ship.prop / Math.max(h2, 1e-12), ship.o2 / Math.max(h2 * O2_PER_H2, 1e-12));
  kw *= scale;
  ship.prop = Math.max(0, ship.prop - h2 * scale);
  ship.o2 = Math.max(0, ship.o2 - h2 * scale * O2_PER_H2);
  power.fcKW = kw;
  return kw;
}

/** Each step: breathing (not docked: the station's air), and the warnings as the tank runs low. */
export function breathe(g: Game, dt: number) {
  const { ship } = g;
  if (!g.dock?.docked) ship.o2 = Math.max(0, ship.o2 - LIFE_O2 * dt);
  const days = o2Days(ship.o2);
  if (days < 3 && !g.warned.o2) {
    g.warned.o2 = true;
    g.showMsg(`Oxygen low · ${fmtTime(days * 86400)} of breathing left · buy it at a station, or split it from ice`, 'warn');
  } else if (days > 4) g.warned.o2 = false;
  return ship.o2 <= 0 && !g.dock?.docked;
}

/** Water coming in to split: the laser boiling ice off a rock, or ice mined on the ground. */
export function waterIn(g: Game) {
  const { ship } = g;
  const l = ship.landed;
  return (!!g.laser.hit && g.laser.rate > 0) || (!!l && l.kind !== 'star' && ([WT.EarthLike, WT.Ocean, WT.Icy] as number[]).includes(l.type));
}

/**
 * Each step: oxygen won from water (the laser's ice, or ice mined on the ground: `water`), by the
 * electrolyser on spare power, and from the air of an Earth-like world with the scoop. Returns the
 * kg/s coming in, for the HUD.
 */
export function gatherO2(g: Game, dt: number, water: boolean) {
  const { ship, power } = g;
  power.electrolysisKW = 0;
  if (dt <= 0 || ship.o2 >= SHIP.o2Cap) return 0;
  let kg = 0;
  if (water && loadOn(g, 'electrolysis') && ship.batt > battCap(ship) * 0.5) {
    // spare power only: what's left on the bus after everything else (it asks last), and not from
    // a battery under half
    const kw = grant(g, ELECTROLYSER_KW, 'electrolyser');
    power.electrolysisKW = kw;
    kg += (kw * dt) / 3600 / ELECTROLYSIS_KWH;
  }
  const unit = scoopFitted(ship.outfit);
  const air = g.aero;
  if (unit && ship.mode === 'normal' && air.body && air.body.type === WT.EarthLike && air.rho > 0) {
    kg += O2_IN_AIR * air.rho * air.speed * AIR_INTAKE * unit.caps.rate * dt;
  }
  kg = Math.min(kg, SHIP.o2Cap - ship.o2);
  ship.o2 += kg;
  if (kg > 0) g.warned.o2 = false;
  return kg / dt;
}
