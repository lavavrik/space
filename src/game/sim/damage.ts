/*
 * Hull damage and repair (docs/damage.md). The hull has an integrity, 0–1 (Ship.hull); at 0 the ship
 * is lost. What wears it:
 *
 *   - impacts — the ground, a station's structure (and later ring rocks): below a scrape speed
 *     nothing, above it damage grows with the square of the excess (energy), reaching a whole
 *     hull's worth at the speed that used to be instantly fatal (`fatal`). So a pristine hull
 *     survives anything a little under that, and a battered one may not survive much;
 *   - heat — above TEMP.critical the structure weakens, faster the hotter it gets (TEMP.fail is
 *     still immediate failure).
 *
 * A docked ship is repaired at the station, for credits (sim/economy.ts buyRepair).
 */
import type { Game } from '../Game';
import type { Body } from '../types';
import { destroyShip } from './flight';
import { TEMP } from './thermal';

/** Integrity where the HUD warns, and where it sounds the alarm. */
export const HULL_WARN = 0.5,
  HULL_CRITICAL = 0.25;

/** Damage (fraction of a whole hull) from hitting something at `v` m/s: 0 up to `scrape`, 1 at `fatal`. */
export function impactDamage(v: number, scrape: number, fatal: number) {
  if (v <= scrape) return 0;
  const x = (v - scrape) / (fatal - scrape);
  return x * x;
}

/**
 * Take an impact at `v` m/s against `what` (for the messages; `shown` is the speed to report, if
 * `v` is an effective one). Returns true if it destroyed the ship (the caller stops handling the contact).
 */
export function impact(g: Game, v: number, scrape: number, fatal: number, what: string, body: Body, shown = v): boolean {
  const d = impactDamage(v, scrape, fatal);
  if (d <= 0) return false;
  return hurt(g, d, `Hit ${what} at ${shown.toFixed(0)} m/s`, body);
}

/** Take `d` of damage; destroyed (true) if it's more than what's left. */
export function hurt(g: Game, d: number, reason: string, body: Body): boolean {
  const { ship } = g;
  if (ship.dead) return true;
  const before = ship.hull;
  ship.hull = Math.max(0, ship.hull - d);
  if (ship.hull <= 0) {
    destroyShip(g, reason, body);
    return true;
  }
  // a message for a real knock (not every frame of heat damage), and when crossing the warning lines
  if (d >= 0.01) g.showMsg(`${reason} · hull damage ${pct(d)} · integrity ${pct(ship.hull)}`, 'warn');
  else if (before > HULL_CRITICAL && ship.hull <= HULL_CRITICAL) g.showMsg(`HULL INTEGRITY ${pct(ship.hull)} · dock for repairs`, 'warn');
  else if (before > HULL_WARN && ship.hull <= HULL_WARN) g.showMsg(`Hull integrity ${pct(ship.hull)} · dock for repairs`, 'warn');
  return false;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Heat damage per second at hull temperature T (K): 0 up to TEMP.critical, 3 %/s at TEMP.fail. */
export function heatDamageRate(T: number) {
  if (T <= TEMP.critical) return 0;
  const x = (T - TEMP.critical) / (TEMP.fail - TEMP.critical);
  return 0.03 * x * x;
}

/** Each step: heat wear. */
export function updateDamage(g: Game, dt: number) {
  const r = heatDamageRate(g.ship.temp);
  if (r > 0 && dt > 0) hurt(g, r * dt, `Hull failed from heat near ${g.cur.star.name}`, g.cur.star);
}
