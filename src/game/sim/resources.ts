import { AU, SCOOP_FLUX_FULL, SCOOP_FLUX_MIN, SHIP, WT } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Ship } from '../types';
import { TEMP } from './thermal';
import { battCap, grant } from './power';
import { RADIATOR_MAX_ACC, outfitMass, scoopFitted } from '../outfit/catalog';

/** Dry mass: the hull plus whatever modules are fitted. */
export const dryMass = (ship: Ship) => SHIP.dry + outfitMass(ship.outfit);
export const shipMass = (ship: Ship) => dryMass(ship) + ship.prop;
/** Rocket equation: Δv the remaining propellant can deliver. */
export const deltaVLeft = (ship: Ship) => SHIP.ve * Math.log((dryMass(ship) + ship.prop) / dryMass(ship));

export function warnOnce(g: Game, key: string, text: string) {
  if (!g.warned[key]) {
    g.warned[key] = true;
    g.showMsg(text, 'warn');
  }
}

/** Spend propellant for a thruster velocity change T (m/s, modified in place if limited).
 *  Tsiolkovsky: burning Δv costs m·(1 − e^(−Δv/ve)) of reaction mass. */
export function applyThrust(g: Game, T: THREE.Vector3, dt: number) {
  const { ship, power } = g;
  let dv = T.length();
  if (dv < 1e-9) return;
  if (ship.prop <= 0) {
    T.set(0, 0, 0);
    warnOnce(g, 'prop', 'Propellant exhausted · refuel at a gas giant, a star, ice, or call a tanker (Shift+K)');
    return;
  }
  // deployed radiator fins can't take hard acceleration
  if (ship.outfit.radiatorsOut > 0 && dv > RADIATOR_MAX_ACC * dt) {
    T.setLength(RADIATOR_MAX_ACC * dt);
    dv = T.length();
    warnOnce(g, 'radAcc', `Radiators out · thrust limited to ${(RADIATOR_MAX_ACC / 9.81).toFixed(0)} g (Shift+R stows them)`);
  }
  // the nozzles need SHIP.kwPerAcc per m/s²: the bus may not have it all (sim/power.ts)
  if (dt > 0) {
    const want = (dv / dt) * SHIP.kwPerAcc;
    const kw = grant(g, want, 'thrusters');
    if (kw < want) {
      T.multiplyScalar(kw / want);
      dv = T.length();
      if (ship.batt <= 0) warnOnce(g, 'batt', 'Battery flat · thrust limited to solar power');
    }
    power.thrustKW += kw;
  }
  dv = Math.min(dv, deltaVLeft(ship));
  T.setLength(dv);
  const m = shipMass(ship);
  const dm = m * (1 - Math.exp(-dv / SHIP.ve));
  ship.prop = Math.max(0, ship.prop - dm);
  power.burn += dm;
}

/** Solar panels on the ship's top face. Output ∝ starlight flux × cos(angle), zero in a shadow. */
export function solarPower(g: Game) {
  const { ship, power, cur } = g;
  const s = cur.star;
  const toS = s.pos.clone().sub(ship.pos);
  const d = toS.length();
  toS.divideScalar(d);
  power.shadow = null;
  for (const b of cur.bodies) {
    if (b === s) continue;
    const w = b.pos.clone().sub(ship.pos);
    const t = w.dot(toS);
    if (t > 0 && t < d && w.lengthSq() - t * t < b.radius * b.radius) {
      power.shadow = b;
      break;
    }
  }
  power.flux = s.L * (AU / d) ** 2;
  power.cos = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q).dot(toS);
  if (power.shadow || ship.temp >= TEMP.panels) return 0; // too hot: panels feathered edge-on
  return Math.min(SHIP.solarMax, SHIP.solarRated * power.flux * Math.max(0, power.cos));
}

/**
 * Refuelling: skim a star's corona or a gas giant's upper atmosphere with a fitted fuel scoop
 * (normal space only), or mine ice on the ground (built in).
 */
export function scoop(g: Game, dt: number) {
  const { ship, cur } = g;
  ship.scoop = '';
  let dp = 0,
    dx = 0;
  const unit = scoopFitted(ship.outfit);
  const k = unit?.caps.rate ?? 0;
  for (const b of cur.bodies) {
    const alt = b.pos.distanceTo(ship.pos) - b.radius;
    const inZone = b.kind === 'star' ? b.L * (AU / (alt + b.radius)) ** 2 >= SCOOP_FLUX_MIN : b.type >= WT.GasGiant && alt < b.radius * 0.05;
    if (inZone && (!unit || ship.mode !== 'normal')) {
      // say why nothing's coming in (once per visit)
      if (!unit) warnOnce(g, 'noScoop', `${b.kind === 'star' ? 'In the corona' : 'In the upper atmosphere'} of ${b.name} · no fuel scoop fitted (fit one at a station, Shift+U)`);
      else warnOnce(g, 'ftlScoop', 'The fuel scoop only works in normal space · drop out of FTL');
      continue;
    }
    if (!unit) continue;
    if (b.kind === 'star') {
      // the outer corona / inner stellar wind: its density, and so the scoop rate, falls off like
      // the starlight (∝ 1/r²); too thin to bother below SCOOP_FLUX_MIN, full rate from SCOOP_FLUX_FULL
      const F = b.L * (AU / (alt + b.radius)) ** 2;
      if (F >= SCOOP_FLUX_MIN) {
        const f = Math.min(1, F / SCOOP_FLUX_FULL);
        dp += 2500 * k * f * dt;
        if (unit.caps.exotic) dx += 1.2 * k * f * dt;
        ship.scoop = `Skimming the corona of ${b.name}`;
      }
    } else if (inZone) {
      const f = Math.min(1, (b.radius * 0.05 - alt) / (b.radius * 0.03));
      dp += 1500 * k * f * dt;
      ship.scoop = `Skimming hydrogen from ${b.name}`;
    }
  }
  if (!ship.scoop) {
    const anyZone = cur.bodies.some((b) => {
      const alt = b.pos.distanceTo(ship.pos) - b.radius;
      return b.kind === 'star' ? b.L * (AU / (alt + b.radius)) ** 2 >= SCOOP_FLUX_MIN : b.type >= WT.GasGiant && alt < b.radius * 0.05;
    });
    if (!anyZone) g.warned.noScoop = g.warned.ftlScoop = false;
  }
  const landed = ship.landed;
  if (landed && landed.kind !== 'star' && ([WT.EarthLike, WT.Ocean, WT.Icy] as number[]).includes(landed.type)) {
    dp += 400 * dt;
    ship.scoop = `Mining water ice on ${landed.name}`;
  }
  // rates for the HUD: only what actually goes in (nothing once a tank is full)
  ship.scoopRate.prop = dt > 0 && ship.prop < SHIP.propCap ? dp / dt : 0;
  ship.scoopRate.exotic = dt > 0 && ship.exotic < SHIP.exoticCap ? dx / dt : 0;
  if (ship.scoop) {
    ship.prop = Math.min(SHIP.propCap, ship.prop + dp);
    ship.exotic = Math.min(SHIP.exoticCap, ship.exotic + dx);
    if (ship.prop > 1000) g.warned.prop = false;
    if (ship.exotic > 1) g.warned.exotic = false;
  }
}

/** Refill everything (tanker, respawn). */
export function refillShip(g: Game) {
  const { ship } = g;
  ship.prop = SHIP.propCap;
  ship.exotic = SHIP.exoticCap;
  ship.batt = battCap(ship);
  g.warned = {};
}
