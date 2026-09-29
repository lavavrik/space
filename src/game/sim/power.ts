/*
 * The power bus. Each frame the ship can spend what the solar panels deliver, external (shore)
 * power while docked at a station, plus what the battery can give (its discharge limit, and only while it holds charge). Loads are granted in the order
 * they ask, after the always-on base load:
 *
 *   base (life support, avionics) → drive charging → FTL drive → thrusters → heat pump
 *
 * A load that gets less than it asked for runs slower rather than failing outright: drive charging
 * stretches (the energy is fixed: 5 kWh for the FTL drive, ~35 kWh for a hyperjump), thrust is
 * capped. The FTL drive is the exception: it needs its full 600 kW or it drops out.
 *
 * Surplus (solar and shore) charges the battery up to its charge acceptance; the rest is curtailed.
 */
import { SHIP } from '../constants';
import type { Game } from '../Game';
import type { Breaker, Ship } from '../types';

export const battCap = (ship: Ship) => ship.outfit.battery.caps.capacity;

/** What the bus can supply this frame (kW): the panels plus the battery's discharge limit. */
export function busCapacity(g: Game) {
  const { ship, power } = g;
  return power.solar + power.shore + (ship.batt > 0 ? ship.outfit.battery.caps.maxKW : 0);
}

/** Start the frame's budget. Uses the panels' output from the previous frame. */
export function beginPower(g: Game) {
  const { power } = g;
  // last frame's loads stay readable (HUD) until the next frame starts
  power.thrustKW = power.ftlKW = power.chargeKW = power.burn = power.shieldKW = power.guardKW = power.laserKW = power.turnKW = 0;
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
  const surplus = power.solar + power.shore - power.draw;
  power.net = surplus >= 0 ? Math.min(surplus, ship.batt < b.capacity ? b.chargeKW : 0) : Math.max(surplus, -b.maxKW);
  power.curtailed = surplus > 0 ? surplus - power.net : 0;
  ship.batt = Math.min(b.capacity, Math.max(0, ship.batt + (power.net * dt) / 3600));
}

/**
 * Loads you can switch on and off (ship stats, U: the power schematic). Life support and avionics
 * can't be. Headlights and the heat pump keep their own switches (Game.lights, the pump's
 * thermostat); the rest are breakers on the ship. Off, a load draws nothing and doesn't work:
 * thrusters give no thrust (the autopilot and docking computer too), the FTL drive won't start and
 * drops out if running, drive charging pauses (FTL and hyperdrive), the radar can't sweep.
 * (Later these could be set to a share of their draw instead, to direct power where it matters.)
 */
export type Switchable = Breaker | 'lights' | 'pump' | 'laser';

export const SWITCH_NAMES: Record<Switchable, string> = {
  thrust: 'Thrusters', ftl: 'FTL drive', charge: 'Drive charging', radar: 'Radar', shield: 'Deflector', guard: 'Collision radar', lights: 'Headlights', pump: 'Heat pump', laser: 'Mining laser',
};

export function loadOn(g: Game, id: Switchable) {
  if (id === 'lights') return g.lights;
  if (id === 'laser') return g.laser.on;
  if (id === 'pump') return g.ship.outfit.pumpAuto;
  return g.ship.breakers[id];
}

function setLoad(g: Game, id: Switchable, on: boolean) {
  if (id === 'lights') g.lights = on;
  else if (id === 'laser') g.laser.on = on;
  else if (id === 'pump') g.ship.outfit.pumpAuto = on;
  else g.ship.breakers[id] = on;
}

export function toggleLoad(g: Game, id: Switchable) {
  const on = !loadOn(g, id);
  setLoad(g, id, on);
  g.showMsg(`${SWITCH_NAMES[id]} ${on ? 'on' : 'off'}`, on ? '' : 'warn');
}

/**
 * Load shedding: when the battery falls below SHED_BELOW of its capacity (in flight), everything
 * but life support, the thrusters and the FTL drive (and its charging) is switched off, so what's
 * left goes to getting home. What it switched off comes back on once the battery is over
 * RESTORE_ABOVE (or docked, on shore power). It acts only as the battery crosses the line: a load
 * you switch back on by hand while it's low stays on.
 *
 * (That includes the heat pump and the belt's deflector and collision radar: the hull can heat
 * up, and a belt is no place to be caught with a flat battery.)
 */
export const SHED_BELOW = 0.1;
export const RESTORE_ABOVE = 0.3;
const SHEDDABLE: Switchable[] = ['laser', 'lights', 'radar', 'shield', 'guard', 'pump'];

export function loadShed(g: Game) {
  const { ship } = g;
  const f = ship.batt / battCap(ship);
  if (!g.shed && f < SHED_BELOW && !g.dock?.docked) {
    g.shed = SHEDDABLE.filter((id) => loadOn(g, id));
    for (const id of g.shed) setLoad(g, id, false);
    if (g.shed.length) g.showMsg(`Battery under ${SHED_BELOW * 100} % · switched off ${g.shed.map((id) => SWITCH_NAMES[id].toLowerCase()).join(', ')} · life support, thrusters and FTL only`, 'warn');
  } else if (g.shed && (f > RESTORE_ABOVE || g.dock?.docked)) {
    const back = g.shed.filter((id) => !loadOn(g, id));
    for (const id of back) setLoad(g, id, true);
    g.shed = null;
    if (back.length) g.showMsg(`Battery at ${Math.round(f * 100)} % · switched back on: ${back.map((id) => SWITCH_NAMES[id].toLowerCase()).join(', ')}`);
  }
}
