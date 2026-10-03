/*
 * Trojan swarms (docs/lagrange.md): loose clouds of rocks round a planet's L4 or L5. A swarm's
 * centre is that point (a free orbit with the planet's period, sim/lagrange.ts trojanRel); its rocks
 * sit still in the frame that moves with it. Like the ring's rocks they're never stored: space round
 * the centre is cut into cubes (SWARM_CELL on a side, axes fixed in space), and a hash of each cube
 * decides whether it holds a rock, where, how big and what kind (the same Stream as the ring's).
 * Whether it does depends on the density where the cube is: a Gaussian round the centre, wide along
 * the orbit and thin across it (`TrojanField.sigA/sigR/sigZ`), so the swarm is thick at its core and
 * gives out ~3σ away.
 *
 * Rocks are drawn from the same data (gpu/swarm.ts) with a shape that the mining laser's ray reads
 * the same way (`swarmRay`): a unit sphere's directions pushed out by three octaves of value noise
 * (a hash on the integer lattice, so the CPU and the GPU agree without a texture), squashed and
 * turned by `rockShape`'s draws.
 *
 * Positions and velocities come out relative to the frame body (the star, outside a planet's
 * sphere of influence), like the ring's, so the laser, the collisions and the HUD read them alike.
 */
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Ship, TrojanField } from '../types';
import { keplerAt, meanAnomalyOf } from './kepler';
import { TROJAN_SHIFT } from './lagrange';
import { Stream, pcg3, rockShape, type Rock } from './ringRocks';

/** Cube edge (m), and how far round the ship rocks are made for the renderer and the laser (m). */
export const SWARM_CELL = 4000;
export const SWARM_REACH = 24e3;
/** Rock radius range (m): a mostly small population with a few boulders. */
export const SWARM_MIN_R = 8,
  SWARM_MAX_R = 300;
/** Inside this exponent of the Gaussian (½ of the σ-distance squared) the swarm is "here": 2 ≈ within 2σ. */
export const SWARM_HERE = 2;

export interface SwarmRock extends Rock {
  /** Keys the mined table: `~` + id (a ring's keys start with a planet's name). */
  key: string;
  field: TrojanField;
}

export const swarmKey = (id: string) => `~${id}`;

const V = () => new THREE.Vector3();

/** The swarm's centre: system-frame position and velocity, and the orbit frame (along, outward, up) there. */
export interface SwarmCentre {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Parent-relative position of the centre, and unit vectors along its motion, out from the parent, and along the orbit's normal. */
  rel: THREE.Vector3;
  along: THREE.Vector3;
  out: THREE.Vector3;
  up: THREE.Vector3;
}

export function swarmCentre(f: TrojanField, c: SwarmCentre = { pos: V(), vel: V(), rel: V(), along: V(), out: V(), up: V() }): SwarmCentre {
  const w = f.planet;
  const par: Body = w.parent;
  const M = meanAnomalyOf(w.orb, c.rel.subVectors(w.pos, par.pos)) + TROJAN_SHIFT[f.k];
  keplerAt(w.orb, M, c.rel, c.vel);
  c.along.copy(c.vel).normalize();
  c.up.crossVectors(c.rel, c.vel).normalize();
  c.out.crossVectors(c.along, c.up).normalize();
  c.pos.addVectors(c.rel, par.pos);
  c.vel.add(par.vel);
  return c;
}

/** ½ of the σ-distance² of an offset `d` (system axes) from the swarm's centre: 0 at the core. */
export function swarmExponent(f: TrojanField, c: SwarmCentre, d: THREE.Vector3) {
  const a = d.dot(c.along) / (f.sigA * c.rel.length()),
    r = d.dot(c.out) / f.sigR,
    z = d.dot(c.up) / f.sigZ;
  return 0.5 * (a * a + r * r + z * z);
}

/** The chance of a rock in a cube at offset `d` from the centre. */
export const swarmDensity = (f: TrojanField, c: SwarmCentre, d: THREE.Vector3) => {
  const e = swarmExponent(f, c, d);
  return e > 9 ? 0 : f.core * Math.exp(-e);
};

const dTmp = V();

/** The swarm the ship is in the core of, if any (its centre filled in), at the clock's time. */
export function swarmHere(cur: CurrentSystem, ship: Ship, frameBody: Body): { field: TrojanField; centre: SwarmCentre } | null {
  if (!cur.trojans?.length) return null;
  for (const f of cur.trojans) {
    if (f.planet.parent !== frameBody) continue; // (only in the parent's frame: outside the planet's sphere of influence)
    const c = swarmCentre(f);
    if (swarmExponent(f, c, dTmp.subVectors(ship.pos, c.pos)) < SWARM_HERE) return { field: f, centre: c };
  }
  return null;
}

/**
 * The rocks of swarm `f` (centre `c`) whose centre lies within `reach` of the segment `a`→`b` (system
 * frame), as ring-style rocks relative to `origin`/`originVel` (the frame body's position and velocity).
 */
export function swarmRocks(f: TrojanField, c: SwarmCentre, a: THREE.Vector3, b: THREE.Vector3, reach: number, origin: THREE.Vector3, originVel: THREE.Vector3, out: SwarmRock[], skip?: (key: string) => boolean, minedGet?: (key: string) => number | undefined): void {
  const lo = V().set(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)).addScalar(-reach).sub(c.pos);
  const hi = V().set(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)).addScalar(reach).sub(c.pos);
  const C = SWARM_CELL;
  const x0 = Math.floor(lo.x / C),
    x1 = Math.floor(hi.x / C),
    y0 = Math.floor(lo.y / C),
    y1 = Math.floor(hi.y / C),
    z0 = Math.floor(lo.z / C),
    z1 = Math.floor(hi.z / C);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 20000) return; // (a long sweep: not a swarm's business)
  const d = V();
  const seed = Math.imul(f.seed >>> 0, 977) >>> 0;
  const O = 1073741824;
  for (let ix = x0; ix <= x1; ix++)
    for (let iy = y0; iy <= y1; iy++)
      for (let iz = z0; iz <= z1; iz++) {
        const [hx, hy, hz] = pcg3((ix + O) >>> 0, (iy + O) >>> 0, (iz + O + seed) >>> 0);
        const st = new Stream((hx ^ hy ^ hz) >>> 0);
        const keep = st.next();
        d.set((ix + 0.5) * C, (iy + 0.5) * C, (iz + 0.5) * C);
        if (keep > swarmDensity(f, c, d)) continue;
        const ox = st.next(),
          oy = st.next(),
          oz = st.next();
        const size0 = SWARM_MIN_R * Math.pow(SWARM_MAX_R / SWARM_MIN_R, Math.pow(st.next(), 2.2));
        const tint = st.next();
        const id = `T:${f.id}:${ix}:${iy}:${iz}`;
        const key = swarmKey(id);
        const left = minedGet ? (minedGet(key) ?? 1) : 1;
        if (left <= 0 || skip?.(key)) continue;
        const pos = V().set((ix + ox) * C, (iy + oy) * C, (iz + oz) * C);
        // (a rock may sit in a neighbouring cube's reach: keep what's really within it)
        const here = pos.clone().add(c.pos);
        if (distToSegment(here, a, b) > reach + size0) continue;
        out.push({ pos: here.sub(origin), vel: c.vel.clone().sub(originVel), size: size0 * left, layer: 1, id, key, field: f, shapeSeed: st.s, size0, tint });
      }
}

const sA = V(),
  sB = V();
function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  sA.subVectors(b, a);
  const l2 = sA.lengthSq();
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, sB.subVectors(p, a).dot(sA) / l2));
  return sB.copy(a).addScaledVector(sA, t).distanceTo(p);
}

/* ---------- the shape: value noise on an integer lattice ---------- */

const imul = Math.imul;
function lattice(ix: number, iy: number, iz: number) {
  let h = (imul(ix, 374761393) + imul(iy, 668265263) + imul(iz, 1274126177)) | 0;
  h = imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [−1, 1]: trilinear, smoothed, on a hashed integer lattice. gpu/shaders/swarmRock.wgsl has the same. */
export function vnoise(x: number, y: number, z: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = smooth(x - ix),
    fy = smooth(y - iy),
    fz = smooth(z - iz);
  const l = (dx: number, dy: number, dz: number) => lattice(ix + dx, iy + dy, iz + dz);
  const x00 = l(0, 0, 0) + (l(1, 0, 0) - l(0, 0, 0)) * fx,
    x10 = l(0, 1, 0) + (l(1, 1, 0) - l(0, 1, 0)) * fx,
    x01 = l(0, 0, 1) + (l(1, 0, 1) - l(0, 0, 1)) * fx,
    x11 = l(0, 1, 1) + (l(1, 1, 1) - l(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy,
    y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** The shape's radius along unit direction d (mesh space) for per-rock offset o (shaders/swarmRock.wgsl shapeR). */
export function swarmShapeR(d: THREE.Vector3, o: THREE.Vector3) {
  return 1 + 0.3 * vnoise(d.x * 0.9 + o.x, d.y * 0.9 + o.y, d.z * 0.9 + o.z) + 0.14 * vnoise(d.x * 2.1 + o.y, d.y * 2.1 + o.z, d.z * 2.1 + o.x) + 0.06 * vnoise(d.x * 4.7 + o.z, d.y * 4.7 + o.x, d.z * 4.7 + o.y);
}

const lP = V(),
  lD = V(),
  lX = V(),
  lQ = new THREE.Quaternion();

/**
 * Where a ray from `from` along unit `dir` (relative to the frame body, like the rock) first meets the
 * rock's drawn surface, as a distance up to maxT; null if it misses. Marches the star-shaped
 * surface in mesh space, then bisects (the ring's rockRay, with this shape).
 */
export function swarmRay(rock: Rock, from: THREE.Vector3, dir: THREE.Vector3, maxT: number): number | null {
  const { q, sc, o } = rockShape(rock);
  lQ.copy(q).invert();
  lP.copy(from).sub(rock.pos).applyQuaternion(lQ).divide(sc);
  lD.copy(dir).applyQuaternion(lQ).divide(sc);
  const a = lD.dot(lD),
    b = 2 * lP.dot(lD),
    c = lP.dot(lP) - 1.5 * 1.5;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t0 = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a)),
    t1 = Math.min(maxT, (-b + Math.sqrt(disc)) / (2 * a));
  if (t1 <= t0) return null;
  const inside = (t: number) => {
    lX.copy(lP).addScaledVector(lD, t);
    const r = lX.length();
    return r < 1e-9 || r < swarmShapeR(lX.divideScalar(r), o);
  };
  if (inside(t0)) return t0;
  const N = 48;
  let prev = t0;
  for (let i = 1; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N;
    if (inside(t)) {
      let lo = prev,
        hi = t;
      for (let k = 0; k < 10; k++) {
        const m = (lo + hi) / 2;
        if (inside(m)) hi = m;
        else lo = m;
      }
      return hi;
    }
    prev = t;
  }
  return null;
}
