import { AU, GRAV, MSUN, REARTH, RSUN, WT } from '../constants';
import { lr, mulberry32, rr, type Rng } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, Star, StarInfo, StarSystem, World, WorldType } from '../types';
import { atmoOf } from '../sim/atmosphere';
import { makeBarycentre, pairOrbits, rocheLobe } from '../sim/barycentre';
import { updateBodies } from '../sim/kepler';
import { starMass } from './binary';
import { habitableZone, makeWorld, rockyType, teq } from './worlds';

function makeStarBody(st: StarInfo, name: string, seed: number): Star {
  const mass = starMass(st.L) * MSUN; // main-sequence mass–luminosity relation
  return {
    kind: 'star',
    name,
    radius: st.R * RSUN,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(), // a lone star anchors the system frame
    color: st.color,
    L: st.L,
    typeName: st.spec + ' star',
    seed,
    mass,
    mu: GRAV * mass,
    soi: Infinity,
    spin: (2 * Math.PI) / ((20 + (seed % 15)) * 86400),
    axis: new THREE.Vector3(0, 1, 0),
    rot: 0,
  };
}

/**
 * Generate every body in a star system from its seed. Always returns the primary star first; a pair
 * (docs/binaries.md) returns both stars first, on their orbits round the barycentre (their parent,
 * which isn't in the list).
 */
export function buildSystem(sys: StarSystem): Body[] {
  const g = mulberry32(sys.seed ^ 0x9e3779b9);
  const st = sys.star;
  const seed = g() * 50;
  const comp = sys.companion;
  if (!comp) {
    const star = makeStarBody(st, sys.name, seed);
    const bodies: Body[] = [star];
    addPlanets(bodies, g, { parent: star, L: st.L, Teff: st.T, prefix: sys.name, starR: star.radius, aMin: 0, aMax: Infinity });
    updateBodies(bodies, 0); // fill in orbital velocities
    return bodies;
  }
  // a pair: both stars round their barycentre, at the origin
  const A = makeStarBody(st, `${sys.name} A`, seed);
  const B = makeStarBody(comp.star, `${sys.name} B`, g() * 50);
  const bary = makeBarycentre(sys.name, A.mass + B.mass);
  const a = comp.a * AU;
  [A.orb, B.orb] = pairOrbits(a, comp.e, A.mass, B.mass, g);
  A.parent = B.parent = bary;
  const bodies: Body[] = [A, B];
  updateBodies(bodies, 0); // (the stars where they start: planets round each are placed from there)
  if (comp.close) {
    // the planets orbit both, from well outside the pair (closer in, orbits are unstable: Holman &
    // Wiegert, ~3.5 separations); the stars' own gravity is summed (sim/gravity.ts), so no SOIs
    A.soi = B.soi = 0;
    addPlanets(bodies, g, { parent: bary, L: A.L + B.L, Teff: (st.L * st.T + comp.star.L * comp.star.T) / (st.L + comp.star.L), prefix: sys.name, starR: Math.max(A.radius, B.radius), aMin: 3.5 * a, aMax: Infinity });
  } else {
    // each its own planets, within 0.3 of the closest approach (stable S-type orbits); each star
    // rules within its Roche lobe (Eggleton's), the barycentre beyond
    const peri = a * (1 - comp.e);
    A.soi = peri * rocheLobe(A.mass / B.mass);
    B.soi = peri * rocheLobe(B.mass / A.mass);
    addPlanets(bodies, g, { parent: A, L: A.L, Teff: st.T, prefix: sys.name, starR: A.radius, aMin: 0, aMax: 0.3 * peri });
    addPlanets(bodies, g, { parent: B, L: B.L, Teff: comp.star.T, prefix: `${sys.name} B`, starR: B.radius, aMin: 0, aMax: 0.3 * peri });
  }
  updateBodies(bodies, 0);
  return bodies;
}

interface PlanetSpec {
  /** What they orbit: a star, or a close pair's barycentre. */
  parent: Star;
  /** The light they get (L☉): a close pair's both. */
  L: number;
  /** Its (their light-weighted) effective temperature, K: where the habitable zone lies. */
  Teff: number;
  /** Their names: "<prefix> 1", "<prefix> 2"… */
  prefix: string;
  /** No closer than 10 of these (the star's radius). */
  starR: number;
  /** No orbit inside aMin; none generated past aMax (m). */
  aMin: number;
  aMax: number;
}

/** A star's (or a pair's) planets and their moons, into `bodies`. */
function addPlanets(bodies: Body[], g: Rng, s: PlanetSpec) {
  const sq = Math.sqrt(s.L),
    snow = 2.7 * sq * AU,
    hz = habitableZone(s.Teff);
  let a = Math.max(rr(g, 0.12, 0.4) * sq * AU, s.starR * 10, s.aMin);
  const n = 3 + Math.floor(g() * 8);
  for (let i = 0; i < n; i++) {
    if (a > s.aMax) break;
    const T = teq(s.L, a / AU);
    const type: WorldType = a > snow ? (g() < 0.72 ? (g() < 0.6 ? WT.GasGiant : WT.IceGiant) : rockyType(T, g, hz)) : g() < 0.05 ? WT.GasGiant : rockyType(T, g, hz);
    let radius: number;
    switch (type) {
      case WT.GasGiant: radius = rr(g, 8, 13) * REARTH; break;
      case WT.IceGiant: radius = rr(g, 3.4, 4.3) * REARTH; break;
      case WT.EarthLike: radius = rr(g, 0.8, 1.4) * REARTH; break;
      case WT.Ocean: radius = rr(g, 1, 1.8) * REARTH; break;
      default: radius = lr(g, 0.3, 1.7) * REARTH;
    }
    const ang = g() * Math.PI * 2,
      inc = rr(g, -0.04, 0.04);
    const pos = new THREE.Vector3(Math.cos(ang) * a, Math.sin(inc) * a, Math.sin(ang) * a).add(s.parent.pos);
    const p: World = makeWorld({ kind: 'planet', name: `${s.prefix} ${i + 1}`, type, radius, pos, parent: s.parent, orbit: a, T }, g);
    const giant = type >= WT.GasGiant;
    if (giant && g() < (type === WT.GasGiant ? 0.4 : 0.22)) {
      p.ring = { inner: rr(g, 1.25, 1.5), outer: rr(g, 2.0, 2.6), color: p.pal.c.clone().lerp(new THREE.Color(0.85, 0.8, 0.7), 0.5), seed: g() * 40 };
    }
    bodies.push(p);

    const nm = type === WT.GasGiant ? 1 + Math.floor(g() * 7) : type === WT.IceGiant ? 1 + Math.floor(g() * 4) : g() < 0.45 ? 1 + (g() < 0.3 ? 1 : 0) : 0;
    let r = radius * (giant ? rr(g, 3.5, 6) : rr(g, 15, 40));
    if (p.ring) r = Math.max(r, radius * p.ring.outer * 1.4);
    let letter = 0;
    for (let j = 0; j < nm; j++) {
      if (r > a * 0.06) break;
      const mr = giant ? lr(g, 1.5e5, 2.6e6) : radius * rr(g, 0.06, 0.27);
      const mt: WorldType = giant ? (g() < 0.12 ? WT.Volcanic : g() < 0.6 ? WT.Icy : WT.Rocky) : T < 200 ? WT.Icy : WT.Rocky;
      const ma = g() * Math.PI * 2,
        mi = rr(g, -0.08, 0.08);
      const mpos = pos.clone().add(new THREE.Vector3(Math.cos(ma) * r, Math.sin(mi) * r, Math.sin(ma) * r));
      const moon = makeWorld({ kind: 'moon', name: '', type: mt, radius: mr, pos: mpos, parent: p, orbit: r, T }, g);
      // a moon must sit well inside its planet's sphere of influence to stay bound as the planet
      // orbits; it's still generated first so skipping it doesn't change anything after it
      if (r < p.soi * 0.5) {
        moon.name = `${p.name} ${'abcdefgh'[letter++]}`;
        bodies.push(moon);
      }
      r *= rr(g, 1.5, 2.3);
    }
    a *= rr(g, 1.45, 2.05);
  }
}

/** The system's centre: a lone star, or a pair's barycentre (the stars' parent). */
export function systemAnchor(bodies: Body[]): Star {
  const s = bodies[0] as Star;
  return s.parent ?? s;
}

/** The home planet: a temperate Earth-like world (10–30 °C at the surface) with at least one moon. */
export function findHome(bodies: Body[]) {
  return bodies.find((b): b is World => {
    if (b.kind !== 'planet' || b.type !== WT.EarthLike) return false;
    const Ts = atmoOf(b)?.Ts ?? 0;
    return Ts > 283 && Ts < 303 && bodies.some((m) => m.kind !== 'star' && m.parent === b);
  });
}
