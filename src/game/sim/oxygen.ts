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
 *   - Water tank (SHIP.waterCap): filled by the fuel cell's exhaust (WATER_PER_H2 kg per kg of
 *     hydrogen it burns) and by ice (the laser boiling it off a rock, or mined on the ground, at
 *     WATER_INTAKE).
 *   - Electrolyser: splits that water back into hydrogen (to the propellant) and oxygen, at
 *     SPLIT_KWH per kg of water (~50 kWh per kg of hydrogen), on spare power only: never from a
 *     battery under half, and never while the fuel cell runs (they'd feed each other). With the fuel
 *     cell that's a regenerative fuel cell: spare sunlight stored as H₂ + O₂ and burned back when
 *     power runs short, at ~37 % round trip (18.3 kWh back of each 50 spent, as real ones).
 *   - Cryocoolers keep the liquid hydrogen (20 K) and oxygen (90 K) cold against the heat leaking in
 *     from the hull (more the hotter it is), drawing CRYO_* power; what they can't hold off (switched
 *     off, or short of power) boils off and is vented.
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
/** The electrolyser's rating (kW). */
export const ELECTROLYSER_KW = 300;
/** Electrolysis: kWh per kg of water split (≈ 50 kWh per kg of hydrogen); its hydrogen share (the rest is oxygen). */
export const SPLIT_KWH = 5.56,
  H2_IN_WATER = 0.112;
/** Water from the fuel cell per kg of hydrogen burned (H₂ + ½O₂ → H₂O); ice taken in while mining (kg/s). */
export const WATER_PER_H2 = 1 + O2_PER_H2,
  WATER_INTAKE = 2;
/**
 * Heat leaking into the tanks through their insulation (W per K of hull over the liquid), the liquid's
 * temperature (K), its heat of vaporization (J/kg), and the cryocooler's share of Carnot efficiency:
 * the big LH₂ tank leaks ~80 W at a 290 K hull, which takes ~7 kW to pump out at 20 K; the LOX tank
 * ~4 W, ~50 W to pump out.
 */
const CRYO = {
  prop: { leak: 0.3, T: 20, latent: 446e3, carnot: 0.15 },
  o2: { leak: 0.02, T: 90, latent: 213e3, carnot: 0.2 },
} as const;
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
  // its exhaust is water, kept for splitting back later (any over the tank's room is vented)
  ship.water = Math.min(SHIP.waterCap, ship.water + h2 * scale * WATER_PER_H2);
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
 * Each step: water taken in (ice, while mining: `water`), split by the electrolyser on spare power
 * into hydrogen and oxygen, and oxygen from the air of an Earth-like world with the scoop. Returns
 * the kg/s of oxygen coming in, for the HUD. (The electrolyser asks the bus last: whatever's left.)
 */
export function gatherO2(g: Game, dt: number, water: boolean) {
  const { ship, power } = g;
  power.electrolysisKW = 0;
  if (dt <= 0) return 0;
  if (water) ship.water = Math.min(SHIP.waterCap, ship.water + WATER_INTAKE * dt);
  let o2 = 0;
  const room = ship.o2 < SHIP.o2Cap - 0.01 || ship.prop < SHIP.propCap - 0.1;
  if (ship.water > 0.01 && room && loadOn(g, 'electrolysis') && ship.batt > battCap(ship) * 0.5 && !power.fcOn) {
    // (asking only for what the water left can use)
    const kw = grant(g, Math.min(ELECTROLYSER_KW, (ship.water * SPLIT_KWH * 3600) / dt), 'electrolyser');
    const w = Math.min(ship.water, (kw * dt) / 3600 / SPLIT_KWH);
    power.electrolysisKW = kw;
    ship.water -= w;
    ship.prop = Math.min(SHIP.propCap, ship.prop + w * H2_IN_WATER);
    o2 += w * (1 - H2_IN_WATER);
  }
  const unit = scoopFitted(ship.outfit);
  const air = g.aero;
  if (unit && ship.mode === 'normal' && air.body && air.body.type === WT.EarthLike && air.rho > 0) {
    o2 += O2_IN_AIR * air.rho * air.speed * AIR_INTAKE * unit.caps.rate * dt;
  }
  o2 = Math.min(o2, SHIP.o2Cap - ship.o2);
  ship.o2 += o2;
  if (o2 > 0) g.warned.o2 = false;
  return o2 / dt;
}

/**
 * Each step (before the loads are summed): the cryocoolers pump out the heat leaking into the LH₂
 * and LOX tanks from the hull. What they can't (switched off, or granted less than they ask) boils
 * off and is vented. Returns kg/s boiling off, per tank.
 */
export function cryo(g: Game, dt: number) {
  const { ship, power } = g;
  const T = Math.max(ship.temp, 30);
  let ask = 0;
  const leak = { prop: 0, o2: 0 };
  for (const k of ['prop', 'o2'] as const) {
    const c = CRYO[k];
    if (ship[k] <= 0) continue;
    leak[k] = c.leak * Math.max(0, T - c.T); // W
    ask += leak[k] / (c.carnot * (c.T / Math.max(1, T - c.T))) / 1000; // kW of input at that COP
  }
  const kw = loadOn(g, 'cryo') && ask > 0 ? grant(g, ask, 'cryocoolers') : 0;
  power.cryoKW = kw;
  const short = ask > 0 ? 1 - kw / ask : 0;
  const boil = { prop: 0, o2: 0 };
  if (short > 0.5 && !g.warned.boil) {
    g.warned.boil = true;
    g.showMsg(`Cryocoolers ${loadOn(g, 'cryo') ? 'short of power' : 'off'} · the liquid hydrogen and oxygen are boiling off`, 'warn');
  } else if (short < 0.1) g.warned.boil = false;
  if (short > 1e-6 && dt > 0) {
    for (const k of ['prop', 'o2'] as const) {
      boil[k] = (short * leak[k]) / CRYO[k].latent;
      ship[k] = Math.max(0, ship[k] - boil[k] * dt);
    }
  }
  return boil;
}
