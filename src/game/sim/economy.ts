/*
 * The economy, first step (docs/economy.md): credits (Cr), paid station services, a cargo hold and
 * metals to sell.
 *
 *   - Credits are yours (Game.credits, saved), not the ship's: a replacement ship keeps them. You
 *     start with START_CREDITS and the fully kitted ship.
 *   - Stations sell propellant and exotic matter, repair the hull, and fit modules; a tanker call
 *     costs a call-out fee plus the fuel at a mark-up. Fuel you scoop, mine or boil off a rock is free.
 *   - Every station's prices differ a little (± ~20 %), from a hash of its name: worth shopping round.
 *   - Modules cost their price to fit; one taken out is bought back at half its list price.
 *   - The hold carries metals from mining (sim/laser.ts): nickel-iron, cobalt and platinum-group
 *     metals, sold at any station. Lost with the ship.
 */
import type { Game } from '../Game';
import { SHIP } from '../constants';
import type { Station } from '../types';
import { holdMass } from './resources';

export const START_CREDITS = 25_000;
/** The hold (kg). Its load counts in the ship's mass (sim/resources.ts dryMass). */
export const CARGO_CAP = 200_000;

export type Commodity = 'nife' | 'cobalt' | 'pgm';
export const COMMODITIES: Record<Commodity, { name: string; price: number }> = {
  // Cr/kg, list: ≈ 0.24 Cr per kg of mixed metal, ~47,000 Cr for a full 200 t hold (a first price
  // of ~10 Cr/kg paid ~200,000 for a 20 t hold: more than any module)
  nife: { name: 'Nickel-iron', price: 0.05 },
  cobalt: { name: 'Cobalt', price: 1 },
  pgm: { name: 'Platinum-group metals', price: 10 },
};
/** A typical rock's metal, by mass (each rock's own mix: sim/laser.ts rockMake). */
export const METAL_SPLIT: Record<Commodity, number> = { nife: 0.9, cobalt: 0.09, pgm: 0.01 };

/** List prices for services. */
export const PRICE = {
  prop: 0.1, // Cr/kg of propellant: a full tank ~12,000
  exotic: 60, // Cr/kg: a full 100 kg ~6,000
  repair: 120, // Cr per percent of hull
  tankerCall: 2500, // the tanker's call-out fee, on top of its fuel
  tankerMarkup: 1.5, // × station prices for what it delivers
  buyBack: 0.5, // share of a module's list price the yard pays for it
};

/** A station's price factor for `what` (0.8–1.2): a hash of its name, steady every visit. */
export function stationFactor(st: Station | null, what: string) {
  if (!st) return 1;
  let h = 2166136261;
  const s = `${st.name}/${what}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return 0.8 + 0.4 * ((h % 10007) / 10007);
}

export const fmtCr = (x: number) => `${Math.round(x).toLocaleString('en-US')} Cr`;

/** Pay `cost`; false (and a message) if you can't. */
export function pay(g: Game, cost: number, what: string) {
  if (cost <= g.credits + 1e-6) {
    g.credits -= cost;
    return true;
  }
  g.showMsg(`Not enough credits for ${what} · ${fmtCr(cost)} (you have ${fmtCr(g.credits)})`, 'warn');
  return false;
}

/** What filling the tanks at this station would cost, and how much of each it takes. */
export function refuelQuote(g: Game, st: Station | null, markup = 1) {
  const { ship } = g;
  const prop = SHIP.propCap - ship.prop,
    exotic = SHIP.exoticCap - ship.exotic;
  const pp = PRICE.prop * stationFactor(st, 'prop') * markup,
    px = PRICE.exotic * stationFactor(st, 'exotic') * markup;
  return { prop, exotic, pp, px, cost: prop * pp + exotic * px };
}

/**
 * Fill the tanks at the station you're docked at, as far as your credits go (propellant first, then
 * exotic matter).
 */
export function buyFuel(g: Game) {
  if (!g.dock?.docked) return;
  const st = g.dock.station;
  const q = refuelQuote(g, st);
  if (q.cost < 0.5) return;
  const prop = Math.min(q.prop, g.credits / q.pp);
  g.credits -= prop * q.pp;
  const exotic = Math.min(q.exotic, g.credits / q.px);
  g.credits -= exotic * q.px;
  g.ship.prop += prop;
  g.ship.exotic += exotic;
  const spent = prop * q.pp + exotic * q.px;
  g.showMsg(prop < q.prop - 1 || exotic < q.exotic - 0.01 ? `${st.name} · bought what ${fmtCr(spent)} would buy · out of credits` : `${st.name} · tanks filled · ${fmtCr(spent)}`, prop < q.prop - 1 ? 'warn' : '');
}

/** What repairing the hull fully costs here. */
export const repairQuote = (g: Game, st: Station | null) => (1 - g.ship.hull) * 100 * PRICE.repair * stationFactor(st, 'repair');

/** Repair as far as your credits go. */
export function buyRepair(g: Game) {
  if (!g.dock?.docked) return;
  const st = g.dock.station;
  const full = repairQuote(g, st);
  if (full < 0.5) return;
  const per = PRICE.repair * stationFactor(st, 'repair') * 100; // per whole hull
  const mend = Math.min(1 - g.ship.hull, g.credits / per);
  g.credits -= mend * per;
  g.ship.hull += mend;
  g.showMsg(g.ship.hull < 0.999 ? `${st.name} · repaired to ${Math.round(g.ship.hull * 100)} % · out of credits` : `${st.name} · hull repaired · ${fmtCr(mend * per)}`);
}

/** A commodity's price at a station (Cr/kg). */
export const sellPrice = (st: Station | null, c: Commodity) => COMMODITIES[c].price * stationFactor(st, c);

/** Everything in the hold (kg): metal and contract crates (sim/contracts.ts). */
export const cargoMass = (g: Game) => holdMass(g.ship);

/** What the hold would fetch here. */
export function cargoValue(g: Game, st: Station | null) {
  let v = 0;
  for (const c of Object.keys(COMMODITIES) as Commodity[]) v += (g.ship.cargo[c] ?? 0) * sellPrice(st, c);
  return v;
}

/** Sell the whole hold at the station you're docked at. */
export function sellCargo(g: Game) {
  if (!g.dock?.docked) return;
  const st = g.dock.station;
  const v = cargoValue(g, st);
  if (v < 0.5) return;
  g.credits += v;
  g.ship.cargo = {};
  g.warned.holdFull = false;
  g.showMsg(`${st.name} · sold the hold for ${fmtCr(v)}`);
}

/** Put mined metal (kg) in the hold, split by `mix` (the rock's), up to its capacity. Returns what fit. */
export function stowMetal(g: Game, kg: number, mix: Record<Commodity, number> = METAL_SPLIT) {
  const room = Math.max(0, CARGO_CAP - cargoMass(g));
  const take = Math.min(kg, room);
  if (take <= 0) return 0;
  for (const c of Object.keys(mix) as Commodity[]) g.ship.cargo[c] = (g.ship.cargo[c] ?? 0) + take * mix[c];
  return take;
}

/** Sell one commodity from the hold at the station you're docked at. */
export function sellOne(g: Game, c: Commodity) {
  if (!g.dock?.docked) return;
  const st = g.dock.station;
  const kg = g.ship.cargo[c] ?? 0;
  if (kg < 0.5) return;
  const v = kg * sellPrice(st, c);
  g.credits += v;
  delete g.ship.cargo[c];
  g.warned.holdFull = false;
  g.showMsg(`${st.name} · sold ${Math.round(kg).toLocaleString('en-US')} kg of ${COMMODITIES[c].name.toLowerCase()} for ${fmtCr(v)}`);
}

/**
 * Dump one commodity out of the hold (in flight: to lighten the ship, or make room for something
 * better). Gone for good; the cargo window asks twice.
 */
export function jettison(g: Game, c: Commodity) {
  const kg = g.ship.cargo[c] ?? 0;
  if (kg < 0.5) return;
  delete g.ship.cargo[c];
  g.warned.holdFull = false;
  g.showMsg(`Jettisoned ${Math.round(kg).toLocaleString('en-US')} kg of ${COMMODITIES[c].name.toLowerCase()}`, 'warn');
}
