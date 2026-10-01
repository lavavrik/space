import { ALBEDO, DENSITY, GRAV, TYPES } from '../constants';
import { hsl } from '../lib/color';
import { mulberry32, rr, type Rng } from '../lib/rng';
import { THREE } from '../lib/three';
import { orbitThrough } from '../sim/kepler';
import type { Body, Palette, World, WorldType } from '../types';

/** Equilibrium temperature (K) at `aAU` from a star of luminosity L. */
export function teq(L: number, aAU: number) {
  return (278 * Math.pow(L, 0.25)) / Math.sqrt(aAU);
}

/** Pick a rocky world type from its temperature. */
export function rockyType(T: number, g: Rng): WorldType {
  if (T > 750) return g() < 0.6 ? 4 : 0;
  if (T > 420) return g() < 0.5 ? 1 : 0;
  if (T > 330) return g() < 0.6 ? 1 : 0;
  if (T > 235) {
    const r = g();
    return r < 0.5 ? 2 : r < 0.7 ? 3 : r < 0.85 ? 1 : 0;
  }
  if (T > 170) {
    const r = g();
    return r < 0.45 ? 0 : r < 0.7 ? 1 : 5;
  }
  return g() < 0.75 ? 5 : 0;
}

/** Surface colours for the planet shader. */
export function palette(type: WorldType, g: Rng): Palette {
  switch (type) {
    case 0: {
      const h = rr(g, 0.03, 0.12),
        s = rr(g, 0.04, 0.22);
      return { a: hsl(h, s, 0.16), b: hsl(h, s * 0.8, 0.52), c: hsl(h + 0.03, s * 1.4, 0.34), d: hsl(h, s, 0.3), sea: 0, atmo: null };
    }
    case 1: {
      const h = rr(g, 0.02, 0.1);
      return { a: hsl(h, 0.5, 0.27), b: hsl(h + 0.02, 0.55, 0.56), c: hsl(h - 0.02, 0.45, 0.4), d: hsl(h, 0.3, 0.5), sea: 0, atmo: { c: hsl(h + 0.03, 0.55, 0.62), k: 0.45 } };
    }
    case 2: {
      const veg = g() < 0.75 ? rr(g, 0.22, 0.33) : rr(g, 0.8, 1.04);
      return { a: hsl(0.61, 0.8, 0.09), b: hsl(0.55, 0.65, 0.3), c: hsl(veg, 0.42, 0.22), d: hsl(rr(g, 0.06, 0.1), 0.28, 0.4), sea: rr(g, -0.04, 0.1), atmo: { c: new THREE.Color(0.3, 0.55, 1.0), k: 0.95 } };
    }
    case 3:
      return { a: hsl(rr(g, 0.58, 0.64), 0.8, 0.08), b: hsl(0.54, 0.7, 0.3), c: hsl(0.3, 0.3, 0.3), d: hsl(0.1, 0.2, 0.5), sea: 0.32, atmo: { c: new THREE.Color(0.35, 0.62, 1.0), k: 1.0 } };
    case 4:
      return { a: hsl(0.02, 0.15, 0.06), b: hsl(0.05, 0.22, 0.2), c: new THREE.Color(1.0, 0.36, 0.05), d: hsl(0, 0, 0.1), sea: 0, atmo: g() < 0.5 ? { c: hsl(0.05, 0.7, 0.45), k: 0.35 } : null };
    case 5: {
      const h = rr(g, 0.5, 0.62);
      return { a: hsl(h, 0.22, 0.55), b: hsl(h, 0.12, 0.88), c: hsl(h + 0.02, 0.45, 0.32), d: hsl(h, 0.1, 0.7), sea: 0, atmo: null };
    }
    case 6: {
      const h = g() < 0.75 ? rr(g, 0.03, 0.12) : rr(g, 0, 1);
      return { a: hsl(h, 0.42, 0.66), b: hsl(h + 0.02, 0.55, 0.38), c: hsl(h - 0.03, 0.25, 0.86), d: hsl(h - 0.02, 0.7, 0.45), sea: 0, atmo: { c: hsl(h, 0.45, 0.72), k: 0.45 } };
    }
    default: {
      const h = rr(g, 0.49, 0.62);
      return { a: hsl(h, 0.5, 0.55), b: hsl(h + 0.02, 0.45, 0.68), c: hsl(h, 0.3, 0.82), d: hsl(h + 0.05, 0.6, 0.34), sea: 0, atmo: { c: hsl(h, 0.6, 0.72), k: 0.6 } };
    }
  }
}

export interface WorldProps {
  kind: 'planet' | 'moon';
  name: string;
  type: WorldType;
  radius: number;
  pos: THREE.Vector3;
  parent: Body;
  orbit: number;
  T: number;
}

/** Tilted spin axis, derived from the body's seed and tilt. */
function spinAxis(seed: number, tilt: number) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(seed), 0, Math.sin(seed)), tilt);
  return new THREE.Vector3(0, 1, 0).applyQuaternion(q);
}

export function makeWorld(props: WorldProps, g: Rng): World {
  const seed = g() * 50,
    tilt = rr(g, 0, 0.45),
    spin = (2 * Math.PI) / (rr(g, 9, 40) * 3600);
  const pal = palette(props.type, g);
  if (titanLike(props, seed)) pal.atmo = { c: hsl(0.08, 0.75, 0.55), k: 0.5 };
  const mass = ((DENSITY[props.type] * 4) / 3) * Math.PI * props.radius ** 3;
  return {
    ...props,
    seed,
    tilt,
    spin,
    axis: spinAxis(seed, tilt),
    rot: seed,
    typeName: TYPES[props.type],
    pal,
    albedo: ALBEDO[props.type],
    mass,
    mu: GRAV * mass,
    // sphere of influence (patched conics): inside it, this body's gravity is the one that counts
    soi: props.orbit * Math.pow(mass / props.parent.mass, 0.4),
    orb: worldOrbit(props, seed),
    vel: props.parent.vel.clone(),
  };
}

/**
 * Whether an icy body keeps a thick nitrogen-methane air (Titan, sim/atmosphere.ts makeAir): only
 * big ones (1,500 km and up: smaller ones' gravity can't hold it) that are cold (under 150 K: warmer,
 * it escapes), and of those one in three. Of the Solar System's many icy moons only Titan has one;
 * Triton's and Pluto's are a hundred-thousandth as thick, and none here. From its own RNG stream
 * (seeded by the body), so the rest of the system generates exactly as before.
 */
function titanLike(props: WorldProps, seed: number) {
  if (props.type !== 5 || props.T >= 150 || props.radius < 1.5e6) return false;
  return mulberry32(Math.floor(seed * 1e6) ^ 0x7174a9)() < 1 / 3;
}

/**
 * A near-circular orbit through the generated position, like real planets and regular moons:
 * eccentricity up to 0.06 for planets and 0.03 for moons, from its own RNG stream (seeded by the
 * body) so the rest of the system generates exactly as before.
 */
function worldOrbit(props: WorldProps, seed: number) {
  const g = mulberry32(Math.floor(seed * 1e6) ^ 0x0b175eed);
  const e = rr(g, 0, props.kind === 'planet' ? 0.06 : 0.03);
  return orbitThrough(props.pos.clone().sub(props.parent.pos), props.parent.mu, e, g() * 2 * Math.PI);
}
