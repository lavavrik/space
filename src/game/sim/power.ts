/*
 * The power bus. Each frame the ship can spend what the solar panels deliver plus what the battery
 * can give (its discharge limit, and only while it holds charge). Loads are granted in the order
 * they ask, after the always-on base load:
 *
 *   base (life support, avionics) → drive charging → FTL drive → thrusters → heat pump
 *
 * A load that gets less than it asked for runs slower rather than failing outright: drive charging
 * stretches (the energy is fixed: 5 kWh for the FTL drive, ~35 kWh for a hyperjump), thrust is
 * capped. The FTL drive is the exception: it needs its full 600 kW or it drops out.
 *
 * Surplus solar charges the battery up to its charge acceptance; the rest is curtailed.
 */
import { SHIP } from '../constants';
import type { Game } from '../Game';
import type { Ship } from '../types';

export const battCap = (ship: Ship) => ship.outfit.battery.caps.capacity;

/** What the bus can supply this frame (kW): the panels plus the battery's discharge limit. */
export function busCapacity(g: Game) {
  const { ship, power } = g;
  return power.solar + (ship.batt > 0 ? ship.outfit.battery.caps.maxKW : 0);
}

/** Start the frame's budget. Uses the panels' output from the previous frame. */
export function beginPower(g: Game) {
  const { power } = g;
  // last frame's loads stay readable (HUD) until the next frame starts
  power.thrustKW = power.ftlKW = power.chargeKW = power.burn = 0;
  power.cap = busCapacity(g);
  power.left = Math.max(0, power.cap - SHIP.baseLoad);
  power.limited = null;
}

/**
 * Ask the bus for `kw`; returns what it can have (0…kw). `what` names the load for the HUD when it
 * gets less than it asked for.
 */
export function grant(g: Game, kw: number, what: string) {
  const { power } = g;
  const k = Math.max(0, Math.min(kw, power.left));
  power.left -= k;
  if (k < kw * 0.999 && !power.limited) power.limited = { what, frac: kw > 0 ? k / kw : 0 };
  return k;
}

/** Settle the battery for the frame: draw from it, or charge it from spare solar (up to its acceptance). */
export function settleBattery(g: Game, dt: number) {
  const { ship, power } = g;
  const b = ship.outfit.battery.caps;
  const surplus = power.solar - power.draw;
  power.net = surplus >= 0 ? Math.min(surplus, ship.batt < b.capacity ? b.chargeKW : 0) : Math.max(surplus, -b.maxKW);
  power.curtailed = surplus > 0 ? surplus - power.net : 0;
  ship.batt = Math.min(b.capacity, Math.max(0, ship.batt + (power.net * dt) / 3600));
}
