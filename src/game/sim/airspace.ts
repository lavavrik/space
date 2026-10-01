/*
 * Restricted airspace over cities (docs/terrain.md "Cities by day"): over a populated world's towns
 * and cities the air below AIRSPACE_FLOOR (over the ground) is closed. The flight computer warns you
 * coming down toward it and, below it, thrusts you back up (with propellant, as any thrust), so the
 * cities are only ever seen from a few kilometres up and are drawn no finer than that (city.wgsl
 * cityDay).
 *
 * Where the cities are: the shader's own layers, worked out the same way here (city.wgsl
 * cityDensity: the population, the urban intensity's fBm and the four layers of towns and cities on
 * it, with the same integer hash), as far as towns ~1 km across; the districts' specks and the
 * blocks finer than that aren't needed for where the floor is.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { NORMAL_ACC } from '../constants';
import type { World } from '../types';
import { frameVel } from './frame';
import { populated, population } from './population';
import { applyThrust } from './resources';
import { altitudeAt, snoise, worldQuat } from './terrain';

/** How far over the ground the cities' airspace is closed (m). */
export const AIRSPACE_FLOOR = 3000;
/** The flight computer warns you this far over the floor (m). */
const WARN_ABOVE = 1500;
/** The town density (cityDensity's L) where the floor starts rising, and where it's full: a margin round
 * each town (its cover starts at 0.08, city.wgsl CITY_C0). Lone villages (the specks) stay open. */
const L0 = 0.04,
  L1 = 0.08;
/** Below the floor, the climb it asks for: proportional to how far under (1/s), CLIMB_MIN to CLIMB_MAX (m/s). */
const CLIMB_K = 0.15,
  CLIMB_MIN = 15,
  CLIMB_MAX = 150;

const sm = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ---- city.wgsl's integer hash (cityPcg, cityHash), in 32-bit unsigned arithmetic (__tests__/airspace.test.ts: the GPU's own outputs) ----
function pcg(x: number, y: number, z: number): [number, number, number] {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x, y, z];
}
const F32 = new Float32Array(1);
const f32 = (v: number) => ((F32[0] = v), F32[0]);
export function cityHash(cx: number, cy: number, cz: number, salt: number, seed: number): [number, number, number] {
  // (the shader: vec3u(vec3i(c) + 2^20) + vec3u(u32(salt), u32(world.seed × 1000), 0), in float32)
  const s = Math.trunc(f32(f32(seed) * 1000)) >>> 0;
  const h = pcg(((Math.trunc(cx) + (1 << 20)) >>> 0) + (salt >>> 0), ((Math.trunc(cy) + (1 << 20)) >>> 0) + s, (Math.trunc(cz) + (1 << 20)) >>> 0);
  return [h[0] / 4294967295, h[1] / 4294967295, h[2] / 4294967295];
}

function citySpots(qx: number, qy: number, salt: number, P: number, r0: number, rk: number, k: number, dmax: number, seed: number) {
  const c0x = Math.floor(qx),
    c0y = Math.floor(qy);
  let sum = 0;
  for (let j = 0; j < 9; j++) {
    const cx = c0x + ((j % 3) - 1),
      cy = c0y + (Math.floor(j / 3) - 1);
    const h = cityHash(cx, cy, salt, 0, seed);
    if (h[0] > P) continue;
    const h2 = cityHash(cx, cy, salt, 31, seed);
    const d = Math.hypot(qx - cx - h2[0], qy - cy - h2[1]) / (r0 * Math.pow(rk, h[1]));
    if (d < dmax) sum += (0.3 + 1.4 * h[2]) * Math.exp(-k * d * d) * sm(dmax, 0.7 * dmax, d);
  }
  return sum;
}

/**
 * The towns' density at unit direction (x, y, z) in `b`'s own frame (city.wgsl cityDensity's L,
 * fully resolved, as from close by): 0 away from them, past ~0.03 built up.
 */
export function townDensity(b: World, x: number, y: number, z: number) {
  const pop = population(b, x, y, z);
  if (pop <= 0) return 0;
  const seed = b.seed;
  const spx = x + seed * 0.37,
    spy = y + 3.1,
    spz = z + seed * 0.21;
  let n = 0,
    amp = 0.5,
    f = 25;
  // (the shader stops where an octave's under a pixel: from a few km up, all ten)
  for (let i = 0; i < 10; i++) {
    n += amp * snoise(spx * f + i * 1.7, spy * f + i * 1.7, spz * f + i * 1.7);
    amp *= 0.6;
    f *= 2;
  }
  const I = sm(0.4, 1, pop * 0.9 + 0.5 * n);
  let L = 0.7 * I + 0.12 * pop;
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  let face: number, u: number, v: number;
  if (ax >= ay && ax >= az) {
    face = x > 0 ? 0 : 1;
    u = y / ax;
    v = z / ax;
  } else if (ay >= az) {
    face = y > 0 ? 2 : 3;
    u = x / ay;
    v = z / ay;
  } else {
    face = z > 0 ? 4 : 5;
    u = x / az;
    v = y / az;
  }
  let s = 30;
  const Pc = 0.2 + 0.4 * pop;
  for (let i = 0; i < 4 && L > 0; i++) {
    const g = 0.15 + (0.85 * citySpots(u * s * 0.5, v * s * 0.5, face * 16 + i, Pc, 0.2, 3.5, 2.5, 1.6, seed) * 4.47) / Pc;
    L *= i === 0 ? Math.pow(g, 0.75) / (0.63 + 0.29 * Pc) : g;
    s *= 4;
  }
  return L;
}

const tq = new THREE.Quaternion(),
  tl = new THREE.Vector3(),
  up = new THREE.Vector3(),
  T = new THREE.Vector3(),
  fv = new THREE.Vector3();

/** The closed airspace's floor over the ground under `pos` on `b` (m; 0: open there). */
export function airspaceFloor(b: World, pos: THREE.Vector3) {
  if (!populated(b)) return 0;
  tl.subVectors(pos, b.pos).normalize().applyQuaternion(worldQuat(b, tq).invert());
  return AIRSPACE_FLOOR * sm(L0, L1, townDensity(b, tl.x, tl.y, tl.z));
}

/** What the HUD shows: the floor here and your height over the ground (null: nowhere near one). */
export interface AirspaceState {
  floor: number;
  h: number;
  world: string;
}

/**
 * Each step after the flight controls: near a populated world's towns, the floor under you; below
 * it, no descending at all (a wall: with boost the pilot's thrust is 3× the normal and outpushed
 * it), a climb back up (CLIMB_K × how far under, CLIMB_MIN to CLIMB_MAX, at up to the normal
 * thrust), and the way across braked (or under a city's edge you could skim in low), with a warning
 * the first time. With propellant, as any thrust.
 */
export function airspaceGuard(g: Game, dt: number) {
  const { ship } = g;
  g.airspace = null;
  const b = g.frameBody;
  if (b.kind === 'star' || !populated(b as World) || ship.landed || g.autodock) return;
  const h = altitudeAt(b, ship.pos);
  if (h > AIRSPACE_FLOOR + WARN_ABOVE + 500) {
    g.warned.airspace = false;
    return;
  }
  const floor = airspaceFloor(b as World, ship.pos);
  if (floor <= 0) {
    g.warned.airspace = false;
    return;
  }
  g.airspace = { floor, h, world: b.name };
  if (h >= floor) return;
  if (!g.warned.airspace) {
    g.warned.airspace = true;
    g.showMsg(`Restricted airspace over ${b.name}'s cities · held above ${(AIRSPACE_FLOOR / 1000).toFixed(0)} km`, 'warn');
  }
  up.subVectors(ship.pos, b.pos).normalize();
  const v0 = ship.vel.clone().sub(frameVel(g, fv));
  const vr = v0.dot(up);
  const want = Math.min(CLIMB_MAX, Math.max(CLIMB_MIN, CLIMB_K * (floor - h)));
  let dv = Math.max(0, -vr);
  if (vr + dv < want) dv += Math.min(want - vr - dv, NORMAL_ACC * dt);
  T.copy(up).multiplyScalar(dv);
  const across = v0.addScaledVector(up, -vr);
  const sa = across.length();
  if (sa > 1e-6) T.addScaledVector(across, -Math.min(sa, NORMAL_ACC * dt) / sa);
  if (T.lengthSq() < 1e-12) return;
  applyThrust(g, T, dt);
  ship.vel.add(T);
}
