import { AU, GRAV, MSUN, REARTH, RSUN, WT } from '../constants';
import { lr, mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, Star, StarSystem, WorldType } from '../types';
import { makeWorld, rockyType, teq } from './worlds';

/** Generate every body in a star system from its seed. Always returns the star first. */
export function buildSystem(sys: StarSystem): Body[] {
  const g = mulberry32(sys.seed ^ 0x9e3779b9);
  const st = sys.star;
  const seed = g() * 50;
  const mass = Math.pow(st.L, 1 / 3.5) * MSUN; // main-sequence mass–luminosity relation
  const star: Star = {
    kind: 'star',
    name: sys.name,
    radius: st.R * RSUN,
    pos: new THREE.Vector3(),
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
  const bodies: Body[] = [star];
  const sq = Math.sqrt(st.L),
    snow = 2.7 * sq * AU;
  let a = Math.max(rr(g, 0.12, 0.4) * sq * AU, star.radius * 10);
  const n = 3 + Math.floor(g() * 8);
  for (let i = 0; i < n; i++) {
    const T = teq(st.L, a / AU);
    const type: WorldType = a > snow ? (g() < 0.72 ? (g() < 0.6 ? WT.GasGiant : WT.IceGiant) : rockyType(T, g)) : g() < 0.05 ? WT.GasGiant : rockyType(T, g);
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
    const pos = new THREE.Vector3(Math.cos(ang) * a, Math.sin(inc) * a, Math.sin(ang) * a);
    const p = makeWorld({ kind: 'planet', name: `${sys.name} ${i + 1}`, type, radius, pos, parent: star, orbit: a, T }, g);
    const giant = type >= WT.GasGiant;
    if (giant && g() < (type === WT.GasGiant ? 0.4 : 0.22)) {
      p.ring = { inner: rr(g, 1.25, 1.5), outer: rr(g, 2.0, 2.6), color: p.pal.c.clone().lerp(new THREE.Color(0.85, 0.8, 0.7), 0.5), seed: g() * 40 };
    }
    bodies.push(p);

    const nm = type === WT.GasGiant ? 1 + Math.floor(g() * 7) : type === WT.IceGiant ? 1 + Math.floor(g() * 4) : g() < 0.45 ? 1 + (g() < 0.3 ? 1 : 0) : 0;
    let r = radius * (giant ? rr(g, 3.5, 6) : rr(g, 15, 40));
    if (p.ring) r = Math.max(r, radius * p.ring.outer * 1.4);
    for (let j = 0; j < nm; j++) {
      if (r > a * 0.06) break;
      const mr = giant ? lr(g, 1.5e5, 2.6e6) : radius * rr(g, 0.06, 0.27);
      const mt: WorldType = giant ? (g() < 0.12 ? WT.Volcanic : g() < 0.6 ? WT.Icy : WT.Rocky) : T < 200 ? WT.Icy : WT.Rocky;
      const ma = g() * Math.PI * 2,
        mi = rr(g, -0.08, 0.08);
      const mpos = pos.clone().add(new THREE.Vector3(Math.cos(ma) * r, Math.sin(mi) * r, Math.sin(ma) * r));
      bodies.push(makeWorld({ kind: 'moon', name: `${p.name} ${'abcdefgh'[j]}`, type: mt, radius: mr, pos: mpos, parent: p, orbit: r, T }, g));
      r *= rr(g, 1.5, 2.3);
    }
    a *= rr(g, 1.45, 2.05);
  }
  return bodies;
}

/** The home planet: an Earth-like world with at least one moon. */
export function findHome(bodies: Body[]) {
  return bodies.find((b) => b.kind === 'planet' && b.type === WT.EarthLike && bodies.some((m) => m.kind !== 'star' && m.parent === b));
}
