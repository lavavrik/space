/*
 * Ship temperature. In vacuum the only way to shed heat is to radiate it (no air to carry it
 * away), so the hull is one lumped heat capacity that warms or cools toward the temperature where
 * what it radiates (εσAT⁴) balances what it takes in:
 *
 *   starlight   α · A⊥ · F        F = the star's flux here; A⊥ = the ship's cross-section facing it
 *   planets     (R/d)² · A/4 · (ε·σT_p⁴ + α·½·albedo·F_p)   infrared glow plus reflected light nearby
 *   internal    every kW the ship draws ends up as heat, except what the exhaust carries away
 *
 * Heat can also leave through fitted radiators (with an optional heat pump; outfit/catalog.ts) or
 * with vented hydrogen (R). The ship is a 60 m × 12 m cylinder along its nose axis: nose-on to the star it shows 113 m², side-
 * on 720 m², so pointing the nose at a star cuts its heating ~6×. With 80 t of structure (≈ aluminium,
 * 900 J/kg·K) it takes hours to settle, and minutes to warm noticeably even very close to a star.
 * See docs/thermal.md for the numbers.
 */
import { AU } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { PUMP_CARNOT, PUMP_ON_ABOVE, RADIATOR_MAX_ACC, RADIATOR_SURFACE, pumpFitted, radiatorArea, radiatorsFitted } from '../outfit/catalog';
import type { Ship, World } from '../types';
import { destroyShip } from './flight';
import { dryMass } from './resources';
import { grant } from './power';

const SIGMA = 5.670374e-8; // Stefan–Boltzmann, W/m²K⁴
/** Solar constant: flux from a Sun-like star at 1 AU, W/m² (power.flux is in these units). */
export const S0 = 1361;

export const HULL = {
  area: 2490, // m², total radiating surface (60 × 12 m cylinder)
  endArea: 113, // m², cross-section nose- or tail-on
  sideArea: 720, // m², cross-section side-on
  absorb: 0.3, // α, solar absorptivity (white thermal paint)
  emit: 0.85, // ε, infrared emissivity
  exhaustKeep: 0.05, // share of nozzle power that stays in the ship as heat
  specificHeat: 900, // J/kg·K of the dry structure (≈ aluminium)
};

/** J/K: the dry structure and fitted modules; the propellant sits in insulated tanks. */
export const heatCap = (ship: Ship) => dryMass(ship) * HULL.specificHeat;

/**
 * Hydrogen vent (R): liquid hydrogen from the propellant tanks is boiled and warmed in a heat
 * exchanger on the hull, then dumped overboard through balanced (thrust-free) vents. Each kilogram
 * takes its latent heat of vaporisation plus the warming of the gas to within `approach` of the hull.
 * The exchanger passes at most `maxW`. It shuts itself off once the hull is down to `stopBelow`.
 */
export const VENT = { maxW: 50e6, approach: 50, latent: 446e3, cp: 12e3, stopBelow: 250 };
/** J carried off per kg of vented hydrogen with the hull at T. */
export const ventHeatPerKg = (T: number) => VENT.latent + VENT.cp * Math.max(0, T - VENT.approach - 20);

/** Docked hulls are brought to this (K) by the station. */
const DOCKED_TEMP = 293;

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
  star: number; // starlight absorbed by the hull
  planets: number; // nearby worlds' glow and reflected light
  internal: number; // the ship's own waste heat (not the heat pump's, which goes to the radiators)
  out: number; // radiated by the hull itself
  radiators: number; // net heat the radiators take off the hull (after their own starlight)
  radAbsorbed: number; // starlight and planet light falling on the radiators
  radTemp: number; // K, the radiator loop
  pumpW: number; // electrical power the heat pump draws
  aero: number; // entry heating (sim/atmosphere.ts)
  air: number; // exchanged with the surrounding air (+ in, − out)
  vent: number; // carried off by vented hydrogen
  ventFlow: number; // kg/s
  /** K/s */
  rate: number;
  /** K: where the hull would settle if nothing changed (without the vent, which runs out) */
  eq: number;
}

const up = new THREE.Vector3(),
  side = new THREE.Vector3();

/** Cross-section (m²) the cylinder shows along unit direction `u` (ship's nose is its local −z). */
export function crossSection(g: Game, u: THREE.Vector3) {
  const c = Math.abs(up.set(0, 0, -1).applyQuaternion(g.ship.q).dot(u));
  return HULL.endArea * c + HULL.sideArea * Math.sqrt(Math.max(0, 1 - c * c));
}

/** A body's blackbody surface temperature from starlight (K), for its infrared glow. */
function bodyTemp(b: World, fluxHere: number) {
  return Math.pow((fluxHere * S0 * (1 - b.albedo)) / (4 * SIGMA), 0.25);
}

/** What the environment and the ship put in (W), independent of the hull temperature. */
interface Inputs {
  star: number;
  planets: number;
  internal: number;
  radAbs: number;
  radArea: number; // m², both faces of the deployed fins
  pumpMaxW: number;
  pumpLift: number;
  aero: number; // W of entry heating
  airCoef: number; // W/K the hull exchanges with the air (convection)
  airT: number; // K, the air's temperature
}

/**
 * Heat the radiators take off a hull at T (W), and what the heat pump draws doing it. Without the
 * pump the loop runs at the hull's temperature. With it the loop runs L hotter: the fins radiate
 * Qr = εσA(T+L)⁴ − absorbed, the pump needs W = Qr / (COP + 1) with COP = ½·T/L (half of Carnot),
 * and the hull loses Qr − W. L is the most the pump's power allows, up to its rated lift.
 */
function radiatorSink(inp: Inputs, T: number) {
  if (inp.radArea <= 0) return { removed: 0, pumpW: 0, radTemp: T };
  const fins = (Tr: number) => RADIATOR_SURFACE.emit * SIGMA * inp.radArea * Tr ** 4 - inp.radAbs;
  const passive = fins(T);
  if (inp.pumpMaxW <= 0 || T < PUMP_ON_ABOVE) return { removed: passive, pumpW: 0, radTemp: T };
  const at = (L: number) => {
    const Qr = fins(T + L);
    const W = L > 0 && Qr > 0 ? Qr / ((PUMP_CARNOT * T) / L + 1) : 0;
    return { Qr, W };
  };
  let L = inp.pumpLift;
  if (at(L).W > inp.pumpMaxW) {
    let lo = 0,
      hi = inp.pumpLift;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid).W > inp.pumpMaxW) hi = mid;
      else lo = mid;
    }
    L = lo;
  }
  const { Qr, W } = at(L);
  return Qr - W > passive ? { removed: Qr - W, pumpW: W, radTemp: T + L } : { removed: passive, pumpW: 0, radTemp: T };
}

/** Net heating (W) of a hull at T, and the parts that depend on T. */
function balance(inp: Inputs, T: number) {
  const out = HULL.emit * SIGMA * HULL.area * T ** 4;
  const rad = radiatorSink(inp, T);
  const air = inp.airCoef * (inp.airT - T);
  return { out, rad, air, net: inp.star + inp.planets + inp.internal + inp.aero + air - out - rad.removed };
}

/** The heat budget at the ship right now (W). Needs solarPower() to have run this frame (flux, shadow). */
export function heatBudget(g: Game, inTunnel: boolean): HeatBudget {
  const { ship, power, cur } = g;
  const finFace = radiatorArea(ship.outfit);
  let star = 0,
    planetFlux = 0, // W per m² of absorbing hull, averaged over directions
    radStar = 0;
  if (!inTunnel) {
    const s = cur.star;
    const toS = s.pos.clone().sub(ship.pos).normalize();
    if (!power.shadow && !g.inStation) {
      star = HULL.absorb * crossSection(g, toS) * power.flux * S0;
      // the fins lie in the plane of the nose and the top: their faces point along the ship's x axis
      const c = Math.abs(side.set(1, 0, 0).applyQuaternion(ship.q).dot(toS));
      radStar = RADIATOR_SURFACE.absorb * finFace * c * power.flux * S0;
    }
    for (const b of cur.bodies) {
      if (b.kind === 'star') continue;
      const d = b.pos.distanceTo(ship.pos);
      if (d > b.radius * 30) continue; // view factor (R/d)² under 0.1%: negligible
      const view = (b.radius / d) ** 2;
      const Fb = s.L * (AU / b.pos.distanceTo(s.pos)) ** 2; // starlight on the body, Earth units
      const glow = HULL.emit * SIGMA * bodyTemp(b, Fb) ** 4;
      const reflected = HULL.absorb * 0.5 * b.albedo * Fb * S0; // about half its disc is sunlit
      planetFlux += view * (glow + reflected);
    }
  }
  const pump = pumpFitted(ship.outfit);
  const inp: Inputs = {
    star,
    planets: planetFlux * (HULL.area / 4),
    internal: 1000 * (power.draw - power.thrustKW * (1 - HULL.exhaustKeep) - power.pumpKW),
    radAbs: radStar + planetFlux * ((2 * finFace) / 4),
    radArea: 2 * finFace,
    pumpMaxW: pump && ship.outfit.pumpAuto ? Math.min(pump.caps.maxKW, Math.max(0, power.left)) * 1000 : 0,
    pumpLift: pump?.caps.lift ?? 0,
    // in air: entry heating, and convection toward the air's temperature (stronger the denser and
    // faster the air: ~15 W/m²K in Earth's still air at sea level)
    aero: g.aero.heatW,
    airCoef: g.aero.rho > 0 ? 15 * Math.sqrt(g.aero.rho / 1.2) * Math.sqrt(1 + g.aero.speed / 20) * HULL.area : 0,
    airT: g.aero.body?.T ?? 0,
  };
  const now = balance(inp, ship.temp);
  // the vent: whatever hydrogen the exchanger can boil off this frame
  let ventFlow = 0,
    vent = 0;
  if (ship.vent && ship.prop > 0) {
    const q = ventHeatPerKg(ship.temp);
    ventFlow = VENT.maxW / q;
    vent = ventFlow * q;
  }
  // equilibrium (without the vent): the net heating falls as T rises, so bisect for where it's zero
  let lo = 3,
    hi = 5000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (balance(inp, mid).net > 0) lo = mid;
    else hi = mid;
  }
  return {
    star,
    planets: inp.planets,
    internal: inp.internal,
    out: now.out,
    radiators: now.rad.removed,
    radAbsorbed: inp.radAbs,
    radTemp: now.rad.radTemp,
    pumpW: now.rad.pumpW,
    aero: inp.aero,
    air: now.air,
    vent,
    ventFlow,
    rate: (now.net - vent) / heatCap(ship),
    eq: lo,
  };
}

/**
 * Advance the hull temperature and apply its effects. Called after the power bookkeeping (it reads
 * this frame's draw) but before the per-frame power totals are cleared.
 */
export function updateThermal(g: Game, dt: number, inTunnel: boolean) {
  const { ship, power } = g;
  const o = ship.outfit;
  // radiators fold out or in at the slowest fitted unit's rate
  const rads = radiatorsFitted(o);
  if (!rads.length) o.radiatorsOut = 0;
  else {
    const rate = 1 / Math.max(...rads.map((r) => r.caps.deployTime));
    o.radiatorsOut = o.deploy ? Math.min(1, o.radiatorsOut + rate * dt) : Math.max(0, o.radiatorsOut - rate * dt);
  }

  const h = (g.heat = heatBudget(g, inTunnel));
  if (g.dock?.docked) {
    // docked: the station's thermal plant takes the hull toward room temperature within minutes
    ship.temp += (DOCKED_TEMP - ship.temp) * Math.min(1, dt / 120);
    power.pumpKW = 0;
    return;
  }
  power.pumpKW = grant(g, h.pumpW / 1000, 'heat pump'); // (it asked for no more than was left)
  if (h.ventFlow > 0) {
    const used = Math.min(ship.prop, h.ventFlow * dt);
    ship.prop -= used;
    if (ship.prop <= 0) {
      ship.vent = false;
      g.showMsg('Hydrogen vent stopped · tanks empty', 'warn');
    }
  }
  // Explicit Euler is fine: without the vent the time constant is hours. Clamp the step so it can't
  // overshoot the equilibrium (a long fast-forward step) unless the vent is pulling it lower.
  const dT = h.rate * dt;
  if (h.vent > 0) ship.temp = Math.max(3, ship.temp + dT);
  else ship.temp = dT > 0 ? Math.min(ship.temp + dT, Math.max(ship.temp, h.eq)) : Math.max(ship.temp + dT, Math.min(ship.temp, h.eq));
  if (ship.vent && ship.temp <= VENT.stopBelow) {
    ship.vent = false;
    g.showMsg(`Hydrogen vent off · hull down to ${VENT.stopBelow} K`);
  }

  const T = ship.temp;
  const alarm = (key: string, at: number, text: string, kind: 'warn' | '' = 'warn') => {
    if (T >= at && !g.warned[key]) {
      g.warned[key] = true;
      g.showMsg(text, kind);
    } else if (T < at - 10) g.warned[key] = false; // re-arm once it has cooled a little
  };
  alarm('heatWarn', TEMP.warn, `Hull ${TEMP.warn} K and rising · nose to the star, move away, or vent hydrogen (R)`);
  alarm('heatPanels', TEMP.panels, `Hull ${TEMP.panels} K · solar panels feathered to protect them`);
  alarm('heatDrives', TEMP.drives, `Hull ${TEMP.drives} K · FTL drive and hyperdrive can't be charged`);
  alarm('heatCritical', TEMP.critical, `HULL ${TEMP.critical} K · STRUCTURE WEAKENING · get away from the star`);
  if (T >= TEMP.fail && !ship.dead) {
    destroyShip(g, `Hull failed at ${TEMP.fail} K · overheated near ${g.cur.star.name}`, g.cur.star);
    ship.temp = TEMP.start;
  }
}

/** R: start or stop venting hydrogen to cool the hull. */
export function toggleVent(g: Game) {
  const { ship } = g;
  if (ship.vent) {
    ship.vent = false;
    g.showMsg('Hydrogen vent off');
  } else if (ship.prop <= 0) g.showMsg('No hydrogen to vent', 'warn');
  else if (ship.temp <= VENT.stopBelow) g.showMsg(`Hull already at ${ship.temp.toFixed(0)} K · the vent works above ${VENT.stopBelow} K`);
  else {
    ship.vent = true;
    const flow = VENT.maxW / ventHeatPerKg(ship.temp);
    g.showMsg(`Venting hydrogen · ${flow.toFixed(1)} kg/s · ${(VENT.maxW / 1e6).toFixed(0)} MW of cooling`);
  }
}

/** Shift+R: fold the radiators out or in. */
export function toggleRadiators(g: Game) {
  const o = g.ship.outfit;
  if (!radiatorsFitted(o).length) {
    g.showMsg('No radiators fitted · fit them at a station (U, then Outfit)', 'warn');
    return;
  }
  o.deploy = !o.deploy;
  g.showMsg(o.deploy ? `Deploying radiators · thrust limited to ${(RADIATOR_MAX_ACC / 9.81).toFixed(0)} g while they're out` : 'Stowing radiators');
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
