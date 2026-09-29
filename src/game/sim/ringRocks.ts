/*
 * The ring's rocks on the CPU, for collisions (docs/rings.md, "Collisions"). The rocks are only ever
 * drawn on the GPU (render/RingField.ts), each from a hash of its cell's global indices; this is an
 * exact replica of that generator (the same integer hash and random stream, in 32-bit maths), so the
 * rock you hit is the one you see. Only the three mesh layers (pebbles, rocks, boulders) matter: the
 * speck layers are the same boulders far away.
 *
 * Where a rock is: radial bin gi (width `cell`, its centre rb = (gi + ½)·cell) turns at the circular
 * orbit rate there, ω = √(μ/rb³); a whole number nth of cells goes round it (dth = 2π/nth). Cell jj of
 * candidate q holds a rock if the first random number is under the ring's density there; then its
 * radius offset du, place along the cell u, height zz and size follow. Its angle at time t is
 * (jj + u)·dth + (ω t mod 2π) from the ring's fixed axis e1 (RingField: e1 = n × X, or n × Z).
 */
import { THREE } from '../lib/three';
import type { World } from '../types';
import { RING_HALF_THICK, ROCK_LAYERS, ringDensity } from './rings';

/** The mesh layers (pebbles, rocks, boulders): the ones collisions consider. */
export const COLLIDE_LAYERS = 3;

const imul = Math.imul;

/** GLSL pcg3 (render/RingField.ts), unsigned 32-bit. */
function pcg3(x: number, y: number, z: number): [number, number, number] {
  x = (imul(x, 1664525) + 1013904223) >>> 0;
  y = (imul(y, 1664525) + 1013904223) >>> 0;
  z = (imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + imul(y, z)) >>> 0;
  y = (y + imul(z, x)) >>> 0;
  z = (z + imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + imul(y, z)) >>> 0;
  y = (y + imul(z, x)) >>> 0;
  z = (z + imul(x, y)) >>> 0;
  return [x, y, z];
}

/** GLSL rnd: a PCG-RXS-M-XS step on a 32-bit state. */
class Stream {
  constructor(public s: number) {}
  next() {
    this.s = (imul(this.s, 747796405) + 2891336453) >>> 0;
    const s = this.s;
    const w = imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
    // (float32 on the GPU: the uint rounds to a float, and so does the quotient)
    return Math.fround(Math.fround(((w >>> 22) ^ w) >>> 0) / 4294967296);
  }
}

export interface Rock {
  /** Position relative to the world's centre (m), at the time asked for. */
  pos: THREE.Vector3;
  /** Velocity relative to the world (m/s): its circular orbit. */
  vel: THREE.Vector3;
  /** Its radius (m): the size the mesh is drawn at (render/RingField.ts). */
  size: number;
  layer: number;
  /** Which rock: layer, radial bin, cell round it, candidate. */
  id: string;
}

/** The ring's fixed in-plane axes, as RingField builds them. */
export function ringAxes(n: THREE.Vector3) {
  const e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  return { e1, e2 };
}

/**
 * Every rock of `layer` whose centre could be within `reach` of the box spanned by the planet-centred
 * points `a` and `b` at time t (s), to `out`. Returns false (and nothing) if that means too many
 * cells to look through (a very long sweep: not in the belt's frame of mind anyway).
 */
export function rocksNear(w: World, layer: number, a: THREE.Vector3, b: THREE.Vector3, reach: number, t: number, out: Rock[], maxCells = 4000): boolean {
  const ring = w.ring;
  if (!ring) return true;
  const L = ROCK_LAYERS[layer];
  const cell = (2 * L.range) / L.grid;
  const n = w.axis;
  const { e1, e2 } = ringAxes(n);
  const pad = reach + L.maxR;
  // the sweep in the ring's cylinder coordinates: height, radius, angle
  const ha = a.dot(n),
    hb = b.dot(n);
  if (Math.min(ha, hb) > RING_HALF_THICK + pad || Math.max(ha, hb) < -RING_HALF_THICK - pad) return true;
  const ra = Math.hypot(a.dot(e1), a.dot(e2)),
    rbb = Math.hypot(b.dot(e1), b.dot(e2));
  const rMin = Math.min(ra, rbb) - pad - cell / 2,
    rMax = Math.max(ra, rbb) + pad + cell / 2;
  const tha = Math.atan2(a.dot(e2), a.dot(e1)),
    thb = Math.atan2(b.dot(e2), b.dot(e1));
  let dTh = thb - tha;
  if (dTh > Math.PI) dTh -= 2 * Math.PI;
  if (dTh < -Math.PI) dTh += 2 * Math.PI;
  const th0 = Math.min(tha, tha + dTh),
    th1 = Math.max(tha, tha + dTh);
  const seed = Math.floor(ring.seed * 1e4) + layer * 7919;
  const K = L.perCell;
  const g0 = Math.floor(rMin / cell - 0.5),
    g1 = Math.ceil(rMax / cell - 0.5);
  let cells = 0;
  for (let gi = g0; gi <= g1; gi++) {
    const rb = (gi + 0.5) * cell;
    if (rb <= 0) continue;
    const dens = Math.fround(ringDensity(w, rb / w.radius) / 0.85); // (a float32 texel on the GPU)
    if (dens <= 0) continue;
    const om = Math.sqrt(w.mu / (rb * rb * rb));
    const nth = Math.max(1, Math.round((2 * Math.PI * rb) / cell));
    const dth = (2 * Math.PI) / nth;
    const turn = (om * t) % (2 * Math.PI);
    const m = pad / rb + dth;
    const j0 = Math.floor((th0 - m - turn) / dth),
      j1 = Math.floor((th1 + m - turn) / dth);
    cells += j1 - j0 + 1;
    if (cells > maxCells) return false;
    for (let j = j0; j <= j1; j++) {
      const jj = ((j % nth) + nth) % nth;
      for (let q = 0; q < K; q++) {
        const [hx, hy, hz] = pcg3((gi + 1073741824) >>> 0, jj >>> 0, (q + imul(seed >>> 0, 977)) >>> 0);
        const st = new Stream((hx ^ hy ^ hz) >>> 0);
        if (st.next() > dens) continue;
        const du = (st.next() - 0.5) * cell,
          u = st.next(),
          zz = (st.next() * 2 - 1) * RING_HALF_THICK;
        const size = L.minR * Math.pow(L.maxR / L.minR, Math.pow(st.next(), 2.2));
        // (j, not jj: the angle continues across the wrap, like the sweep's)
        const th = (j + u) * dth + turn;
        const rr = rb + du;
        const c = Math.cos(th),
          s = Math.sin(th);
        const pos = new THREE.Vector3().addScaledVector(e1, rr * c).addScaledVector(e2, rr * s).addScaledVector(n, zz);
        // it orbits at its bin's rate (the whole bin turns together, as drawn)
        const vel = new THREE.Vector3().addScaledVector(e1, -rr * s * om).addScaledVector(e2, rr * c * om);
        out.push({ pos, vel, size, layer, id: `${layer}:${gi}:${jj}:${q}` });
      }
    }
  }
  return true;
}

/* ---------- collisions ---------- */

/** A rock as a sphere: its drawn radius times this (they're elongated, 1 : ~0.75 : ~0.68, and lumpy). */
const ROCK_K = 0.8;
/** Rock density (kg/m³): ice and rock rubble. */
const ROCK_RHO = 1500;
/** How bouncy a hit is (coefficient of restitution). */
const BOUNCE = 0.3;
/** Below this approach speed (m/s), after scaling for the rock's mass, a hit does no damage; at CRASH_SPEED it takes the whole hull. */
const ROCK_SCRAPE = 3;

const tA = new THREE.Vector3(),
  tB = new THREE.Vector3(),
  tS0 = new THREE.Vector3(),
  tD = new THREE.Vector3();

/** The earliest hit along a step: which rock, when (0–1 of the step), and the normal (rock → ship). */
export interface RockHit {
  rock: Rock;
  t: number;
  normal: THREE.Vector3;
}

/**
 * Sweep a sphere of radius shipR from `a` to `b` (planet-centred, over the step dt ending at time t)
 * against the rocks: the earliest one touched, if any. Each rock's own motion over the step is
 * taken out, so the sweep is the ship's path relative to it.
 */
export function sweepRocks(w: World, a: THREE.Vector3, b: THREE.Vector3, dt: number, t: number, shipR: number, skip?: (id: string) => boolean): RockHit | null {
  let best: RockHit | null = null;
  const list: Rock[] = [];
  for (let layer = 0; layer < COLLIDE_LAYERS; layer++) {
    list.length = 0;
    // (the rocks move too: widen the search by how far one goes in the step)
    if (!rocksNear(w, layer, a, b, shipR + 100, t, list)) continue;
    for (const rock of list) {
      if (skip?.(rock.id)) continue;
      const R = rock.size * ROCK_K + shipR;
      // the ship relative to the rock at the start and end of the step
      tS0.copy(a).sub(tA.copy(rock.pos).addScaledVector(rock.vel, -dt));
      tD.copy(b).sub(rock.pos).sub(tS0); // the relative path over the step
      const A = tD.lengthSq(),
        B = 2 * tS0.dot(tD),
        C = tS0.lengthSq() - R * R;
      let th: number;
      if (C <= 0) {
        if (B >= 0) continue; // already touching and moving apart
        th = 0;
      } else {
        const disc = B * B - 4 * A * C;
        if (A < 1e-12 || disc < 0) continue;
        th = (-B - Math.sqrt(disc)) / (2 * A);
        if (th < 0 || th > 1) continue;
      }
      if (best && th >= best.t) continue;
      best = { rock, t: th, normal: tB.copy(tS0).addScaledVector(tD, th).normalize().clone() };
    }
  }
  return best;
}

/** A rock's mass (kg): a lumpy ellipsoid of its size. */
export const rockMass = (size: number) => ROCK_RHO * (4 / 3) * Math.PI * size ** 3 * 0.5;

/**
 * The approach speed (m/s) a hit counts as for damage: the real one scaled by √(μ / m_ship), with
 * μ the reduced mass. A rock much heavier than the ship is like the ground; a pebble has to be
 * fast to hurt (a 2 m one: ~0.4 × its speed).
 */
export function effectiveSpeed(vn: number, rock: number, ship: number) {
  const mu = (rock * ship) / (rock + ship);
  return vn * Math.sqrt(mu / ship);
}

export { BOUNCE, ROCK_K, ROCK_SCRAPE };

/**
 * How a rock is named: by its size across (its long axis is twice its drawn radius, `size`), which
 * is what you judge by eye. ("50 m" for a rock ~100 m long read as far too small.)
 */
export const rockLabel = (size: number) => (size < 5 ? `${(2 * size).toFixed(1)} m` : `${Math.round(2 * size)} m`);

const qR = new THREE.Quaternion();
/**
 * A rock `dt` seconds on from (pos, vel), planet-centred: turned about the ring's axis at its orbit
 * rate. (Carrying it on in a straight line drifted ~200 m off it in 15 s: its orbit bends by ω²r,
 * ~2 m/s², the same as your own.)
 */
export function rockOn(axis: THREE.Vector3, pos: THREE.Vector3, vel: THREE.Vector3, dt: number, outPos: THREE.Vector3, outVel: THREE.Vector3) {
  const r = Math.sqrt(Math.max(1, pos.lengthSq() - pos.dot(axis) ** 2));
  const om = vel.length() / r;
  qR.setFromAxisAngle(axis, om * dt);
  outPos.copy(pos).applyQuaternion(qR);
  outVel.copy(vel).applyQuaternion(qR);
}
