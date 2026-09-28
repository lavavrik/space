/*
 * Atmospheres (docs/atmosphere.md): density that falls off exponentially with height, the drag and
 * entry heating it puts on the ship, and the numbers the sky and cloud shaders use.
 *
 * Density ρ(h) = ρ0 · e^(−h/H) above the mean radius. The scale height H = R_gas·T / (M·g) follows
 * the world's temperature and surface gravity (Earth: ~8 km). ρ0 and the gas's molar mass M go by
 * type: Earth-like 1.2 kg/m³ of N₂/O₂, oceans a little denser, deserts thin (Mars-like dust), volcanic
 * worlds thick CO₂, giants hydrogen (their "surface" is the cloud tops). The air turns with its world.
 *
 * Drag: a = ρ v² Cd A / (2 m) against the ship's motion through the air, A its cross-section along
 * that motion (nose-first is ~6× smaller than side-on). Entry heating: the Sutton–Graves stagnation
 * heating q = k √(ρ / r_n) v³ over that cross-section, of which HEAT_SHARE ends up in the hull.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, World } from '../types';

/** Surface density (kg/m³) and molar mass (kg/mol) by world type; null: no air. */
const AIR: ({ rho0: number; M: number } | null)[] = [
  null, // rocky
  { rho0: 0.25, M: 0.044 }, // desert: thin dusty CO₂
  { rho0: 1.2, M: 0.029 }, // Earth-like
  { rho0: 1.5, M: 0.029 }, // ocean
  { rho0: 8, M: 0.044 }, // volcanic: thick CO₂ (when it has an atmosphere at all)
  null, // icy
  { rho0: 0.5, M: 0.0023 }, // gas giant: H₂/He at the cloud tops
  { rho0: 0.5, M: 0.0025 }, // ice giant
];
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

export interface Atmo {
  rho0: number; // kg/m³ at the mean radius
  H: number; // scale height, m
  top: number; // m above the mean radius where it ends (ATMO_TOP_H scale heights)
}

const cache = new WeakMap<World, Atmo | null>();

/** The world's atmosphere, if it has one. */
export function atmoOf(b: Body): Atmo | null {
  if (b.kind === 'star' || !b.pal.atmo) return null;
  let a = cache.get(b);
  if (a === undefined) {
    const air = AIR[b.type];
    if (!air) a = null;
    else {
      const g = b.mu / (b.radius * b.radius);
      const H = (R_GAS * Math.max(b.T, 60)) / (air.M * g);
      a = { rho0: air.rho0, H, top: H * ATMO_TOP_H };
    }
    cache.set(b, a);
  }
  return a;
}

/** Air density (kg/m³) at a height above the mean radius. */
export const density = (a: Atmo, h: number) => (h > a.top ? 0 : a.rho0 * Math.exp(-Math.max(h, 0) / a.H));

const tmp = new THREE.Vector3(),
  airVel = new THREE.Vector3(),
  dir = new THREE.Vector3();

/** What the air is doing to the ship this step, for the HUD and the heat budget. */
export interface AeroState {
  body: World | null;
  rho: number; // kg/m³ around the ship
  speed: number; // m/s through the air
  drag: number; // m/s² deceleration
  heatW: number; // W into the hull
}
export const noAero = (): AeroState => ({ body: null, rho: 0, speed: 0, drag: 0, heatW: 0 });

/**
 * Drag and entry heating on the ship for this step (normal space, flying; not landed or docked).
 * `section(u)` gives its cross-section (m²) along unit direction u, `mass` its mass (kg).
 */
export function updateAero(g: Game, dt: number, section: (u: THREE.Vector3) => number, mass: number): AeroState {
  const { ship } = g;
  const s = g.aero;
  s.body = null;
  s.rho = s.speed = s.drag = s.heatW = 0;
  const b = g.frameBody;
  const a = atmoOf(b);
  if (!a || ship.mode !== 'normal' || ship.landed || g.dock?.docked || g.inStation || dt <= 0) return s;
  const rel = tmp.subVectors(ship.pos, b.pos);
  const h = rel.length() - b.radius;
  const rho = density(a, h);
  if (rho <= 0) return s;
  const w = b as World;
  // the air turns with the world: its velocity in the frame body's frame
  airVel.copy(w.axis).multiplyScalar(w.spin).cross(rel);
  const vRel = dir.subVectors(ship.vel, airVel);
  const v = vRel.length();
  s.body = w;
  s.rho = rho;
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
