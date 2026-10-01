/*
 * Atmospheres (docs/atmosphere.md): each world's air, generated from its seed, the drag and entry
 * heating it puts on the ship, and the numbers the sky and cloud shaders use.
 *
 * A world's air is a surface pressure and a mix of gases, by type (makeAir): Mars-like thin CO₂ on
 * most deserts (a few hot ones thick, Venus-like), N₂/O₂ on Earth-like and ocean worlds, crushing
 * CO₂/SO₂ on hot volcanic worlds (a thin SO₂ haze on cold, tidally heated moons), H₂/He on the giants (1 bar at the cloud tops, their
 * "surface"). From those:
 *
 *   - molar mass M: the mix's average;
 *   - surface temperature Ts: the world's equilibrium temperature warmed by the greenhouse effect,
 *     Ts = T · (1 + 0.75 τ)^¼ with an infrared optical depth τ that grows with pressure and with
 *     CO₂, water vapour and methane (Earth-like: +20–40 K; a 90-bar CO₂ world: hundreds of K);
 *   - surface density ρ0 = P M / (R Ts) (ideal gas; Earth 1.2 kg/m³, Venus 65);
 *   - scale height H = R Ts / (M g) (Earth ~8 km); density ρ(h) = ρ0 e^(−h/H), pressure alike;
 *   - air temperature: Ts at the ground, cooling with height toward the world's skin temperature.
 *
 * Drag: a = ρ v² Cd A / (2 m) against the ship's motion through the air, A its cross-section along
 * that motion (nose-first is ~6× smaller than side-on). Entry heating: the Sutton–Graves stagnation
 * heating q = k √(ρ / r_n) v³ over that cross-section, of which HEAT_SHARE ends up in the hull. In
 * dense, hot air the hull also soaks up heat by convection (sim/thermal.ts), so on a Venus-like
 * surface it lasts minutes, not hours.
 */
import type { Game } from '../Game';
import { lr, mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, World } from '../types';

const R_GAS = 8.314;
/** The top of the atmosphere, in scale heights (density down to 6 millionths of the surface's). */
export const ATMO_TOP_H = 12;
/**
 * Drag coefficient, Sutton–Graves constant (SI, air), effective nose radius (m) and the share of the
 * heating the hull keeps. The ship has no heat shield, so it all soaks in; the small effective nose
 * radius (its edges and fittings, not the 12 m hull) is tuned so a shallow 6 km/s entry heats the
 * hull by ~250 K and a steep or faster one can cook it.
 */
const CD = 1,
  SG_K = 1.7415e-4,
  NOSE_R = 0.6,
  HEAT_SHARE = 1;

/** Gases: molar mass (kg/mol) and infrared opacity per bar of partial pressure (greenhouse). */
export const GASES = {
  'N₂': { M: 0.028, ir: 0 },
  'O₂': { M: 0.032, ir: 0 },
  Ar: { M: 0.04, ir: 0 },
  'CO₂': { M: 0.044, ir: 2.2 },
  'H₂O': { M: 0.018, ir: 25 },
  'SO₂': { M: 0.064, ir: 8 },
  'H₂': { M: 0.002, ir: 0 },
  He: { M: 0.004, ir: 0 },
  'CH₄': { M: 0.016, ir: 20 },
  'NH₃': { M: 0.017, ir: 10 },
} as const;
export type Gas = keyof typeof GASES;
/** Opacity per bar from pressure broadening alone (any gas). */
const IR_BASE = 0.5;

export interface Atmo {
  P0: number; // Pa at the mean radius
  gases: [Gas, number][]; // mole fractions, largest first, summing to 1
  M: number; // kg/mol
  tau: number; // infrared optical depth (greenhouse)
  Ts: number; // K, air temperature at the mean radius
  Tskin: number; // K, where the air's temperature tends high up
  rho0: number; // kg/m³ at the mean radius
  H: number; // scale height, m
  top: number; // m above the mean radius where it ends (ATMO_TOP_H scale heights)
}

/** A mix from rough shares (normalised), largest first. */
function mix(parts: [Gas, number][]): [Gas, number][] {
  const sum = parts.reduce((s, [, x]) => s + x, 0);
  return parts
    .filter(([, x]) => x > 0)
    .map(([gas, x]): [Gas, number] => [gas, x / sum])
    .sort((a, b) => b[1] - a[1]);
}

/** Surface pressure (bar) and gases for a world of type `type` at equilibrium temperature T; null: none. */
export function makeAir(type: number, T: number, r: () => number): { bar: number; gases: [Gas, number][] } | null {
  switch (type) {
    case 1: {
      // desert: mostly Mars-like, some moderate, a few hot ones with runaway greenhouse air
      const u = r();
      if (T > 350 && u < 0.12) return { bar: lr(r, 8, 60), gases: mix([['CO₂', 90], ['N₂', rr(r, 3, 9)], ['SO₂', rr(r, 0.1, 1)]]) };
      if (u < 0.4) return { bar: lr(r, 0.1, 1.5), gases: mix([['CO₂', rr(r, 30, 80)], ['N₂', rr(r, 15, 60)], ['Ar', rr(r, 1, 4)]]) };
      return { bar: lr(r, 0.004, 0.08), gases: mix([['CO₂', 95], ['N₂', rr(r, 1.5, 4)], ['Ar', rr(r, 1, 2.5)]]) };
    }
    case 2:
      // Earth-like: N₂/O₂, a little water and CO₂
      return { bar: lr(r, 0.6, 2.2), gases: mix([['N₂', rr(r, 70, 82)], ['O₂', rr(r, 15, 26)], ['Ar', rr(r, 0.5, 1.5)], ['H₂O', rr(r, 0.2, 1.2)], ['CO₂', rr(r, 0.03, 0.4)]]) };
    case 3:
      // ocean: thicker and wetter
      return { bar: lr(r, 1, 4), gases: mix([['N₂', rr(r, 72, 88)], ['O₂', rr(r, 6, 20)], ['H₂O', rr(r, 1, 3)], ['Ar', rr(r, 0.5, 1.5)], ['CO₂', rr(r, 0.05, 0.8)]]) };
    case 4:
      // volcanic (those with air): hot ones, crushing CO₂ with sulphur (Venus); cold ones are
      // tidally heated moons whose volcanoes keep up a thin sulphur-dioxide haze (Io, only thicker)
      if (T < 300) return { bar: lr(r, 0.001, 0.05), gases: mix([['SO₂', 90], ['CO₂', rr(r, 2, 8)], ['N₂', rr(r, 1, 4)]]) };
      return { bar: lr(r, 20, 95), gases: mix([['CO₂', 96], ['N₂', rr(r, 2, 4)], ['SO₂', rr(r, 0.1, 0.6)]]) };
    case 5:
      // icy, the few that have air (universe/worlds.ts titanLike): Titan's, nitrogen with a few
      // per cent methane, thicker than Earth's
      return { bar: lr(r, 0.8, 3), gases: mix([['N₂', 95], ['CH₄', rr(r, 1.5, 6)], ['Ar', rr(r, 0.01, 0.1)]]) };
    case 6:
      // gas giant: 1 bar at the cloud tops
      return { bar: 1, gases: mix([['H₂', rr(r, 84, 90)], ['He', rr(r, 9, 14)], ['CH₄', rr(r, 0.2, 0.5)], ['NH₃', rr(r, 0.01, 0.05)]]) };
    case 7:
      // ice giant: more helium and methane
      return { bar: 1, gases: mix([['H₂', rr(r, 78, 84)], ['He', rr(r, 14, 19)], ['CH₄', rr(r, 1.5, 2.5)]]) };
    default:
      return null;
  }
}

const cache = new WeakMap<World, Atmo | null>();

/** The world's atmosphere, if it has one (generated from its seed, so the same every visit). */
export function atmoOf(b: Body): Atmo | null {
  if (b.kind === 'star' || !b.pal.atmo) return null;
  let a = cache.get(b);
  if (a === undefined) {
    const air = makeAir(b.type, b.T, mulberry32(Math.floor(b.seed * 1e6) ^ 0xa1b2c3));
    if (!air) a = null;
    else {
      const M = air.gases.reduce((s, [gas, x]) => s + x * GASES[gas].M, 0);
      const tau = air.bar * (IR_BASE + air.gases.reduce((s, [gas, x]) => s + x * GASES[gas].ir, 0));
      const giant = b.type >= 6;
      // giants: no greenhouse at the cloud tops (their deep heat is their own)
      const Ts = giant ? b.T : b.T * Math.pow(1 + 0.75 * tau, 0.25);
      const P0 = air.bar * 1e5;
      const g = b.mu / (b.radius * b.radius);
      const H = (R_GAS * Math.max(Ts, 60)) / (M * g);
      a = { P0, gases: air.gases, M, tau, Ts, Tskin: b.T * 0.84, rho0: (P0 * M) / (R_GAS * Ts), H, top: H * ATMO_TOP_H };
    }
    cache.set(b, a);
  }
  return a;
}

/**
 * How far under a giant's face (its cloud tops, 1 bar) you can go before you're crushed (m): 3 scale
 * heights, ~20 bar (sim/flight.ts collide). Its clouds go down to 2.5 (sim/cloudKind.ts).
 */
export const crushDepth = (a: Atmo) => 3 * a.H;

/** Air pressure (Pa) at a height above the mean radius (under it too, down to a giant's crush depth). */
export const pressure = (a: Atmo, h: number) => (h > a.top ? 0 : a.P0 * Math.exp(-Math.max(h, -crushDepth(a)) / a.H));

/** Air temperature (K) at a height: the surface's, cooling toward the skin temperature aloft. */
export const airTemp = (a: Atmo, h: number) => a.Tskin + (a.Ts - a.Tskin) * Math.exp(-Math.max(h, 0) / (1.5 * a.H));

/** Air density (kg/m³) at a height above the mean radius. */
export const density = (a: Atmo, h: number) => (h > a.top ? 0 : a.rho0 * Math.exp(-Math.max(h, -crushDepth(a)) / a.H));

const tmp = new THREE.Vector3(),
  airVel = new THREE.Vector3(),
  dir = new THREE.Vector3();

/** What the air is doing to the ship this step, for the HUD and the heat budget. */
export interface AeroState {
  body: World | null;
  rho: number; // kg/m³ around the ship
  P: number; // Pa around the ship
  T: number; // K, the air's temperature around the ship
  /** Infrared optical depth of the air above the ship: how much of the sky glows at the air's temperature (1 − e^−τ). */
  tauAbove: number;
  speed: number; // m/s through the air
  drag: number; // m/s² deceleration
  heatW: number; // W into the hull
}
export const noAero = (): AeroState => ({ body: null, rho: 0, P: 0, T: 0, tauAbove: 0, speed: 0, drag: 0, heatW: 0 });

/**
 * Drag and entry heating on the ship for this step (normal space, flying; not landed or docked).
 * `section(u)` gives its cross-section (m²) along unit direction u, `mass` its mass (kg).
 */
export function updateAero(g: Game, dt: number, section: (u: THREE.Vector3) => number, mass: number): AeroState {
  const { ship } = g;
  const s = g.aero;
  s.body = null;
  s.rho = s.P = s.T = s.tauAbove = s.speed = s.drag = s.heatW = 0;
  const b = g.frameBody;
  const a = atmoOf(b);
  if (!a || ship.mode !== 'normal' || g.dock?.docked || g.inStation || dt <= 0) return s;
  const rel = tmp.subVectors(ship.pos, b.pos);
  const h = rel.length() - b.radius;
  const rho = density(a, h);
  if (rho <= 0) return s;
  const w = b as World;
  // the air around the ship, landed or flying: its pressure and temperature (the hull trades heat with it)
  s.body = w;
  s.rho = rho;
  s.P = pressure(a, h);
  s.T = airTemp(a, h);
  s.tauAbove = (a.tau * s.P) / a.P0;
  if (ship.landed) return s; // sitting still in it: no drag or entry heating
  // the air turns with the world: its velocity in the frame body's frame
  airVel.copy(w.axis).multiplyScalar(w.spin).cross(rel);
  const vRel = dir.subVectors(ship.vel, airVel);
  const v = vRel.length();
  s.speed = v;
  if (v < 1e-3) return s;
  vRel.divideScalar(v);
  const A = section(vRel);
  const acc = (rho * v * v * CD * A) / (2 * mass);
  // never more than stops it dead in this step
  const dv = Math.min(v, acc * dt);
  ship.vel.addScaledVector(vRel, -dv);
  s.drag = acc;
  s.heatW = SG_K * Math.sqrt(rho / NOSE_R) * v * v * v * A * HEAT_SHARE;
  return s;
}
