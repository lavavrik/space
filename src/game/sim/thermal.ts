/*
 * Ship temperature. In vacuum the only way to shed heat is to radiate it (no air to carry it
 * away), so the hull is one lumped heat capacity that warms or cools toward the temperature where
 * what it radiates (εσAT⁴) balances what it takes in:
 *
 *   starlight   α · A⊥ · F        F = the star's flux here; A⊥ = the ship's cross-section facing it
 *   planets     (R/d)² · A/4 · (ε·σT_p⁴ + α·½·albedo·F_p)   infrared glow plus reflected light nearby
 *   internal    every kW the ship draws ends up as heat, except what the exhaust carries away
 *
 * The ship is a 60 m × 12 m cylinder along its nose axis: nose-on to the star it shows 113 m², side-
 * on 720 m², so pointing the nose at a star cuts its heating ~6×. With 80 t of structure (≈ aluminium,
 * 900 J/kg·K) it takes hours to settle, and minutes to warm noticeably even very close to a star.
 * See docs/thermal.md for the numbers.
 */
import { AU, SHIP } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { World } from '../types';
import { destroyShip } from './flight';

const SIGMA = 5.670374e-8; // Stefan–Boltzmann, W/m²K⁴
/** Solar constant: flux from a Sun-like star at 1 AU, W/m² (power.flux is in these units). */
export const S0 = 1361;

export const HULL = {
  heatCap: SHIP.dry * 900, // J/K: the dry structure; the propellant sits in insulated tanks
  area: 2490, // m², total radiating surface (60 × 12 m cylinder)
  endArea: 113, // m², cross-section nose- or tail-on
  sideArea: 720, // m², cross-section side-on
  absorb: 0.3, // α, solar absorptivity (white thermal paint)
  emit: 0.85, // ε, infrared emissivity
  exhaustKeep: 0.05, // share of nozzle power that stays in the ship as heat
};

/** Temperatures (K) where things happen. */
export const TEMP = {
  start: 280,
  warn: 400, // hot: warning
  panels: 500, // solar panels feathered edge-on to protect them: no solar power
  drives: 600, // FTL drive and hyperdrive coils can't be charged (a running drive keeps going)
  critical: 800, // structure weakening: red alarm
  fail: 900, // hull fails: ship lost
};

/** Where the heat is coming from and going to right now (W), for the HUD. */
export interface HeatBudget {
  star: number;
  planets: number;
  internal: number;
  out: number;
  /** K/s */
  rate: number;
  /** K: where the hull would settle if nothing changed */
  eq: number;
}

const up = new THREE.Vector3();

/** Cross-section (m²) the cylinder shows along unit direction `u` (ship's nose is its local −z). */
function crossSection(g: Game, u: THREE.Vector3) {
  const c = Math.abs(up.set(0, 0, -1).applyQuaternion(g.ship.q).dot(u));
  return HULL.endArea * c + HULL.sideArea * Math.sqrt(Math.max(0, 1 - c * c));
}

/** A body's blackbody surface temperature from starlight (K), for its infrared glow. */
function bodyTemp(b: World, fluxHere: number) {
  return Math.pow((fluxHere * S0 * (1 - b.albedo)) / (4 * SIGMA), 0.25);
}

/** The heat budget at the ship right now (W). Needs solarPower() to have run this frame (flux, shadow). */
export function heatBudget(g: Game, inTunnel: boolean): HeatBudget {
  const { ship, power, cur } = g;
  let star = 0,
    planets = 0;
  if (!inTunnel) {
    const s = cur.star;
    const toS = s.pos.clone().sub(ship.pos).normalize();
    if (!power.shadow) star = HULL.absorb * crossSection(g, toS) * power.flux * S0;
    for (const b of cur.bodies) {
      if (b.kind === 'star') continue;
      const d = b.pos.distanceTo(ship.pos);
      if (d > b.radius * 30) continue; // view factor (R/d)² under 0.1%: negligible
      const view = (b.radius / d) ** 2;
      const Fb = s.L * (AU / b.pos.distanceTo(s.pos)) ** 2; // starlight on the body, Earth units
      const glow = HULL.emit * SIGMA * bodyTemp(b, Fb) ** 4;
      const reflected = HULL.absorb * 0.5 * b.albedo * Fb * S0; // about half its disc is sunlit
      planets += view * (HULL.area / 4) * (glow + reflected);
    }
  }
  const internal = 1000 * (power.draw - power.thrustKW * (1 - HULL.exhaustKeep));
  const out = HULL.emit * SIGMA * HULL.area * ship.temp ** 4;
  const input = star + planets + internal;
  return { star, planets, internal, out, rate: (input - out) / HULL.heatCap, eq: Math.pow(input / (HULL.emit * SIGMA * HULL.area), 0.25) };
}

/**
 * Advance the hull temperature and apply its effects. Called after the power bookkeeping (it reads
 * this frame's draw) but before the per-frame power totals are cleared.
 */
export function updateThermal(g: Game, dt: number, inTunnel: boolean) {
  const { ship } = g;
  const h = (g.heat = heatBudget(g, inTunnel));
  // implicit enough: the time constant is hours, so even long fast-forward steps stay stable; clamp
  // the step toward equilibrium so a huge dt can't overshoot it
  const dT = h.rate * dt;
  ship.temp = dT > 0 ? Math.min(ship.temp + dT, Math.max(ship.temp, h.eq)) : Math.max(ship.temp + dT, Math.min(ship.temp, h.eq));

  const T = ship.temp;
  const alarm = (key: string, at: number, text: string, kind: 'warn' | '' = 'warn') => {
    if (T >= at && !g.warned[key]) {
      g.warned[key] = true;
      g.showMsg(text, kind);
    } else if (T < at - 10) g.warned[key] = false; // re-arm once it has cooled a little
  };
  alarm('heatWarn', TEMP.warn, `Hull ${TEMP.warn} K and rising · turn the nose to the star or move away`);
  alarm('heatPanels', TEMP.panels, `Hull ${TEMP.panels} K · solar panels feathered to protect them`);
  alarm('heatDrives', TEMP.drives, `Hull ${TEMP.drives} K · FTL drive and hyperdrive can't be charged`);
  alarm('heatCritical', TEMP.critical, `HULL ${TEMP.critical} K · STRUCTURE WEAKENING · get away from the star`);
  if (T >= TEMP.fail && !ship.dead) {
    destroyShip(g, `Hull failed at ${TEMP.fail} K · overheated near ${g.cur.star.name}`, g.cur.star);
    ship.temp = TEMP.start;
  }
}

/** Why the drives can't be charged because of heat, if they can't. */
export function heatBlocked(temp: number) {
  return temp >= TEMP.drives ? `Hull too hot to charge the drive (${temp.toFixed(0)} K, limit ${TEMP.drives} K)` : null;
}

/** The next temperature limit above `T`, if any. */
export function nextLimit(T: number): { at: number; what: string } | null {
  const steps: [number, string][] = [
    [TEMP.warn, 'hot'],
    [TEMP.panels, 'panels feathered'],
    [TEMP.drives, 'drives locked'],
    [TEMP.critical, 'critical'],
    [TEMP.fail, 'hull failure'],
  ];
  for (const [at, what] of steps) if (T < at) return { at, what };
  return null;
}
